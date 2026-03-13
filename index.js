console.log("[API] Node process starting...");
import path from "path";
import fs from "fs";
import crypto from "crypto";
import https from "https";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import axios from "axios";
import { SignedXml } from "xml-crypto";
import { XMLParser } from "fast-xml-parser";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, ".env") });

import express from "express";
import cors from "cors";
import multer from "multer";
import Stripe from "stripe";
import mysql from "mysql2/promise";

const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Fiscal (fiskalizacija) retry config
const FISKAL_CONFIG = {
  companyOib: process.env.COMPANY_OIB,
  inVat: String(process.env.COMPANY_VAT_IN_SYSTEM).toLowerCase() === "true",
  operatorOib: process.env.OPERATOR_OIB,
  paymentMethod: process.env.PAYMENT_METHOD || "T",
  invoiceSequenceMode: process.env.INVOICE_SEQUENCE_MODE || "P",
  fiskalEnv: process.env.FISKAL_ENV || "test",
  certPath: process.env.FISKAL_CERT_PATH,
  keyPath: process.env.FISKAL_KEY_PATH,
  caPath: process.env.FISKAL_CA_PATH,
};

// mer (moj-eRačun) config - https://legacy-mer.moj-eracun.hr/en/Manual/Stable/Api
const MER_CONFIG = {
  apiUrl: process.env.MER_API_URL || "https://legacy-mer.moj-eracun.hr",
  username: process.env.MER_USERNAME,
  password: process.env.MER_PASSWORD,
  softwareId: process.env.MER_SOFTWARE_ID || "ColorForgePrints",
  companyName: process.env.COMPANY_NAME || "Company",
  companyAddress: process.env.COMPANY_ADDRESS || "",
  companyCity: process.env.COMPANY_CITY || "",
  companyPostalCode: process.env.COMPANY_POSTAL_CODE || "",
};

function isMerConfigured() {
  return !!(MER_CONFIG.username && MER_CONFIG.password);
}

const FISKAL_SOAP_URL =
  FISKAL_CONFIG.fiskalEnv === "production"
    ? "https://cis.porezna-uprava.hr:8449/FiskalizacijaService"
    : "https://cistest.apis-it.hr:8449/FiskalizacijaServiceTest";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
});

function loadFile(file) {
  return fs.readFileSync(path.resolve(file), "utf8");
}

function formatMoney(n) {
  return Number(n).toFixed(2);
}

function createZki({ oib, dateTime, invoiceNumber, businessSpaceCode, cashRegisterCode, totalAmount, privateKeyPem }) {
  const raw = [oib, dateTime, invoiceNumber, businessSpaceCode, cashRegisterCode, formatMoney(totalAmount)].join("");
  const signer = crypto.createSign("RSA-SHA1");
  signer.update(raw, "utf8");
  signer.end();
  const sigHex = signer.sign(privateKeyPem).toString("hex");
  return crypto.createHash("md5").update(sigHex, "utf8").digest("hex");
}

function certBody(certPem) {
  return certPem.replace("-----BEGIN CERTIFICATE-----", "").replace("-----END CERTIFICATE-----", "").replace(/\r?\n/g, "").trim();
}

function buildFiscalXml(order, zki) {
  const pdv = order.vatRate > 0
    ? `
      <tns:Pdv>
        <tns:Porez>
          <tns:Stopa>${formatMoney(order.vatRate)}</tns:Stopa>
          <tns:Osnovica>${formatMoney(order.vatBase)}</tns:Osnovica>
          <tns:Iznos>${formatMoney(order.vatAmount)}</tns:Iznos>
        </tns:Porez>
      </tns:Pdv>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="http://www.apis-it.hr/fin/2012/types/f73" xmlns:xd="http://www.w3.org/2000/09/xmldsig#">
  <soapenv:Header/>
  <soapenv:Body>
    <tns:RacunZahtjev Id="racunId">
      <tns:Zaglavlje>
        <tns:IdPoruke>${order.idPoruke}</tns:IdPoruke>
        <tns:DatumVrijeme>${order.racunDateTime}</tns:DatumVrijeme>
      </tns:Zaglavlje>
      <tns:Racun>
        <tns:Oib>${FISKAL_CONFIG.companyOib}</tns:Oib>
        <tns:USustPdv>${FISKAL_CONFIG.inVat ? "true" : "false"}</tns:USustPdv>
        <tns:DatVrijeme>${order.racunDateTime}</tns:DatVrijeme>
        <tns:OznSlijed>${FISKAL_CONFIG.invoiceSequenceMode}</tns:OznSlijed>
        <tns:BrRac>
          <tns:BrOznRac>${order.brOznRac}</tns:BrOznRac>
          <tns:OznPosPr>${order.oznPosPr}</tns:OznPosPr>
          <tns:OznNapUr>${order.oznNapUr}</tns:OznNapUr>
        </tns:BrRac>
        ${pdv}
        <tns:IznosUkupno>${formatMoney(order.totalGross)}</tns:IznosUkupno>
        <tns:NacinPlac>${FISKAL_CONFIG.paymentMethod}</tns:NacinPlac>
        <tns:OibOper>${FISKAL_CONFIG.operatorOib}</tns:OibOper>
        <tns:ZastKod>${zki}</tns:ZastKod>
        <tns:NakDost>true</tns:NakDost>
      </tns:Racun>
    </tns:RacunZahtjev>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function buildMerUbl(order) {
  const oib = FISKAL_CONFIG.companyOib || process.env.COMPANY_OIB || "";
  const invId = order.invoiceNumberHuman || order.brOznRac || order.idPoruke;
  const issueDate = (order.racunDateTime || new Date().toISOString()).slice(0, 10);
  const vatRate = Number(order.vatRate) || 0;
  const vatBase = Number(order.vatBase) || Number(order.totalGross) || 0;
  const vatAmount = Number(order.vatAmount) || 0;
  const totalGross = Number(order.totalGross) || 0;
  const recipientOib = order.recipientOib || "00000000000";
  const recipientName = order.recipientName || "Kupac";
  const recipientEmail = order.recipientEmail || "";
  const isPersonal = order.isPersonal !== false && (!recipientOib || recipientOib === "00000000000");

  const customerContact = isPersonal && recipientEmail
    ? `
      <cac:Contact>
        <cbc:ElectronicMail>${recipientEmail}</cbc:ElectronicMail>
      </cac:Contact>`
    : "";

  const taxSubtotal =
    vatRate > 0
      ? `
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="EUR">${formatMoney(vatBase)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="EUR">${formatMoney(vatAmount)}</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:ID>S</cbc:ID>
        <cbc:Percent>${formatMoney(vatRate)}</cbc:Percent>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>`
      : `
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="EUR">${formatMoney(totalGross)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="EUR">0.00</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:ID>E</cbc:ID>
        <cbc:Percent>0</cbc:Percent>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<ubl:Invoice xmlns:ubl="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>urn:cen.eu:en16931:2017</cbc:CustomizationID>
  <cbc:ProfileID>urn:cen.eu:en16931:2017</cbc:ProfileID>
  <cbc:ID>${invId}</cbc:ID>
  <cbc:IssueDate>${issueDate}</cbc:IssueDate>
  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cbc:EndpointID schemeID="9934">HR${oib}</cbc:EndpointID>
      <cac:PartyName>
        <cbc:Name>${MER_CONFIG.companyName}</cbc:Name>
      </cac:PartyName>
      <cac:PostalAddress>
        <cbc:StreetName>${MER_CONFIG.companyAddress || "-"}</cbc:StreetName>
        <cbc:CityName>${MER_CONFIG.companyCity || "-"}</cbc:CityName>
        <cbc:PostalZone>${MER_CONFIG.companyPostalCode || ""}</cbc:PostalZone>
        <cac:Country>
          <cbc:IdentificationCode>HR</cbc:IdentificationCode>
        </cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>HR${oib}</cbc:CompanyID>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${MER_CONFIG.companyName}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cac:Party>
      <cbc:EndpointID schemeID="9934">HR${recipientOib}</cbc:EndpointID>
      <cac:PartyName>
        <cbc:Name>${recipientName}</cbc:Name>
      </cac:PartyName>
      ${customerContact}
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${recipientName}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingCustomerParty>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="EUR">${formatMoney(vatAmount)}</cbc:TaxAmount>
    ${taxSubtotal}
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="EUR">${formatMoney(vatBase)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="EUR">${formatMoney(vatBase)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="EUR">${formatMoney(totalGross)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="EUR">${formatMoney(totalGross)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  <cac:InvoiceLine>
    <cbc:ID>1</cbc:ID>
    <cbc:InvoicedQuantity unitCode="C62">1</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="EUR">${formatMoney(vatBase)}</cbc:LineExtensionAmount>
    <cac:Item>
      <cbc:Name>${order.itemDescription || "Usluga"}</cbc:Name>
      <cac:ClassifiedTaxCategory>
        <cbc:ID>${vatRate > 0 ? "S" : "E"}</cbc:ID>
        <cbc:Percent>${formatMoney(vatRate)}</cbc:Percent>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="EUR">${formatMoney(vatBase)}</cbc:PriceAmount>
      <cbc:BaseQuantity unitCode="C62">1</cbc:BaseQuantity>
    </cac:Price>
  </cac:InvoiceLine>
</ubl:Invoice>`;
}

async function sendToMer(ublXml) {
  const url = `${MER_CONFIG.apiUrl.replace(/\/$/, "")}/apis/v2/send`;
  const companyOib = FISKAL_CONFIG.companyOib || process.env.COMPANY_OIB || "";
  const body = {
    Username: MER_CONFIG.username,
    Password: MER_CONFIG.password,
    SoftwareId: MER_CONFIG.softwareId,
    Document: ublXml,
  };
  if (companyOib) body.CompanyId = companyOib;

  const response = await axios.post(url, body, {
    headers: { "Content-Type": "application/json; charset=utf-8" },
    timeout: 30000,
    validateStatus: () => true,
  });

  if (response.status >= 400) {
    const err = new Error(`Request failed with status code ${response.status}`);
    err.response = response;
    err.detail = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
    throw err;
  }
  return response.data;
}

function signFiscalXml(xml, certPem, keyPem) {
  const sig = new SignedXml();
  sig.signatureAlgorithm = "http://www.w3.org/2000/09/xmldsig#rsa-sha1";
  sig.canonicalizationAlgorithm = "http://www.w3.org/2001/10/xml-exc-c14n#";
  sig.privateKey = keyPem;
  sig.keyInfoProvider = {
    getKeyInfo() {
      return `<X509Data><X509Certificate>${certBody(certPem)}</X509Certificate></X509Data>`;
    },
    getKey() {
      return certPem;
    }
  };
  sig.addReference({
    xpath: "//*[local-name(.)='RacunZahtjev']",
    transforms: [
      "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
      "http://www.w3.org/2001/10/xml-exc-c14n#"
    ],
    digestAlgorithm: "http://www.w3.org/2000/09/xmldsig#sha1",
    uri: "#racunId"
  });
  sig.computeSignature(xml, {
    location: {
      reference: "//*[local-name(.)='RacunZahtjev']",
      action: "append"
    }
  });
  return sig.getSignedXml();
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || ".jpg";
    cb(null, `order_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB

const {
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  DB_HOST = "localhost",
  DB_USER,
  DB_PASSWORD,
  DB_NAME,
  CLIENT_ORIGIN = "http://localhost:8080",
  PORT = "4000",
} = process.env;

let stripe = null;
if (STRIPE_SECRET_KEY && STRIPE_SECRET_KEY.startsWith("sk_")) {
  stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-11-20.acacia" });
} else {
  console.error("[API] STRIPE_SECRET_KEY missing or invalid (must start with sk_test_ or sk_live_). Set in Hostinger → Environment Variables.");
}

const app = express();

// Health check - responds before any heavy init
app.get("/", (req, res) => {
  res.json({ ok: true, message: "ColorForge API" });
});

app.use(
  cors({
    origin: true,
  })
);

// Stripe webhook needs raw body - must be before express.json()
app.post(
  "/api/webhooks/stripe",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    if (!stripe) return res.status(503).json({ error: "Stripe not configured" });
    const sig = req.headers["stripe-signature"];
    if (!STRIPE_WEBHOOK_SECRET || !sig) {
      return res.status(400).send("Webhook secret required");
    }
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error("Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type !== "checkout.session.completed") {
      return res.json({ received: true });
    }

    const session = event.data.object;
    const { metadata, customer_email, amount_total } = session;
    if (!metadata || !isMerConfigured()) {
      return res.json({ received: true });
    }

    try {
      const amountCents = amount_total || 0;
      const vatRate = 25;
      const totalGross = amountCents / 100;
      const vatBase = Math.round((totalGross / (1 + vatRate / 100)) * 100) / 100;
      const vatAmount = Math.round((totalGross - vatBase) * 100) / 100;

      const invId = `CF-${session.id.slice(-8).toUpperCase()}`;
      const isBusiness = metadata.isBusiness === "1" && metadata.companyOib;
      const order = {
        invoiceNumberHuman: invId,
        idPoruke: `cf-${session.id}`,
        racunDateTime: new Date().toISOString().slice(0, 19).replace("T", "T"),
        brOznRac: invId,
        oznPosPr: "1",
        oznNapUr: "1",
        vatRate,
        vatBase,
        vatAmount,
        totalGross,
        isPersonal: !isBusiness,
        recipientOib: isBusiness ? metadata.companyOib : "00000000000",
        recipientName: metadata.customerName || "Kupac",
        recipientEmail: metadata.customerEmail || customer_email || "",
        itemDescription: `${metadata.tierColors || "?"}-Color HueForge${metadata.hasGlow === "1" ? " + Glow" : ""}`,
      };

      const ublXml = buildMerUbl(order);
      const merResponse = await sendToMer(ublXml);
      const electronicId = merResponse?.ElectronicId ?? merResponse?.electronicId;
      console.log(`[Webhook] Invoice ${invId} → mer OK${electronicId ? ` (ElectronicId: ${electronicId})` : ""}${order.isPersonal ? ` → email to ${order.recipientEmail}` : " (business, no email)"}`);
    } catch (err) {
      console.error("[Webhook] Invoice send to mer failed:", err.message, err.detail || "");
    }
    return res.json({ received: true });
  }
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let pool = null;
if (DB_HOST && DB_USER && DB_NAME) {
  pool = await mysql.createPool({
    host: DB_HOST,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
  });
} else {
  console.warn("MySQL env vars not set; DB persistence is disabled.");
}

// Map tier (colors) to price in cents
const PRICE_BY_COLORS = {
  3: 2900,
  4: 4000,
  5: 5300,
};

// Create Stripe Checkout Session - redirects to payment, invoice sent on success
app.post(
  "/api/create-checkout-session",
  upload.single("image"),
  async (req, res) => {
    if (!stripe) {
      return res.status(503).json({ error: "Stripe not configured. Set STRIPE_SECRET_KEY in environment." });
    }
    try {
      const raw = req.body?.data ? JSON.parse(req.body.data) : req.body || {};
      const {
        tierColors,
        hasGlow,
        paletteMode,
        paletteName,
        baseColors,
        glowColor,
        customerEmail,
        customerName,
        isBusiness,
        companyOib,
        companyName,
      } = raw;

      if (!tierColors || !PRICE_BY_COLORS[tierColors]) {
        return res.status(400).json({ error: "Invalid or missing tierColors" });
      }

      const amount = PRICE_BY_COLORS[tierColors] + (hasGlow ? 700 : 0);
      const productName = `${tierColors}-Color HueForge Print${hasGlow ? " + Glow" : ""}`;

      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency: "eur",
              product_data: {
                name: productName,
                description: paletteName ? `Palette: ${paletteName}` : "ColorForge custom print",
              },
              unit_amount: amount,
            },
            quantity: 1,
          },
        ],
        customer_email: customerEmail || undefined,
        metadata: {
          tierColors: String(tierColors),
          hasGlow: hasGlow ? "1" : "0",
          paletteMode: paletteMode || "",
          paletteName: paletteName || "",
          baseColors: JSON.stringify(baseColors || []),
          glowColor: glowColor || "",
          customerName: customerName || "",
          customerEmail: customerEmail || "",
          isBusiness: isBusiness ? "1" : "0",
          companyOib: companyOib || "",
          companyName: companyName || "",
        },
        success_url: `${CLIENT_ORIGIN || "http://localhost:8080"}?payment=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${CLIENT_ORIGIN || "http://localhost:8080"}?payment=cancelled`,
      });

      return res.json({ url: session.url });
    } catch (err) {
      console.error("Checkout session error:", err);
      return res.status(500).json({ error: err.message || "Internal server error" });
    }
  }
);

// Contact form: name, email, question, optional image
app.post("/api/contact", upload.single("image"), async (req, res) => {
  try {
    const name = req.body.name?.trim();
    const email = req.body.email?.trim();
    const question = req.body.question?.trim();

    if (!name || !email || !question) {
      return res.status(400).json({
        error: "Name, email and question are required.",
      });
    }

    const imagePath = req.file ? "uploads/" + req.file.filename : null;
    if (pool) {
      try {
        await pool.execute(
          `INSERT INTO contact_submissions (name, email, question, image_path) VALUES (?, ?, ?, ?)`,
          [name, email, question, imagePath]
        );
      } catch (dbErr) {
        console.error("Contact DB insert failed (table may not exist):", dbErr);
      }
    }

    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Preview UBL for testing (POST with order JSON in body)
app.post("/api/fiscal-preview", (req, res) => {
  try {
    const order = req.body || {};
    const ublXml = buildMerUbl(order);
    if (req.query.format === "xml") return res.type("application/xml").send(ublXml);
    res.json({ ublXml });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const listenPort = process.env.PORT || PORT || 4000;
app.listen(listenPort, "0.0.0.0", () => {
  console.log(`[API] Server listening on port ${listenPort}`);
});

