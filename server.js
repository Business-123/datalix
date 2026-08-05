const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Config (set these in Railway → Variables) --------------------------
const HUB_URL = (process.env.HUB_URL || "").replace(/\/+$/, "");
const HUB_API_KEY = process.env.HUB_API_KEY || "";
const HUB_API_SECRET = process.env.HUB_API_SECRET || "";
const SITE_URL = (process.env.SITE_URL || "").replace(/\/+$/, "");
const ADMIN_KEY = process.env.ADMIN_KEY || "";

// ---- Tiny JSON "database" for orders -------------------------------------
const DATA_DIR = path.join(__dirname, "data");
const ORDERS_FILE = path.join(DATA_DIR, "orders.json");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, "[]");

function readOrders() {
  try {
    return JSON.parse(fs.readFileSync(ORDERS_FILE, "utf8"));
  } catch {
    return [];
  }
}
function writeOrders(orders) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
}
function saveOrder(order) {
  const orders = readOrders();
  orders.push(order);
  writeOrders(orders);
}
function updateOrder(orderId, patch) {
  const orders = readOrders();
  const idx = orders.findIndex((o) => o.orderId === orderId);
  if (idx === -1) return null;
  orders[idx] = { ...orders[idx], ...patch, updatedAt: new Date().toISOString() };
  writeOrders(orders);
  return orders[idx];
}
function findOrderByReference(reference) {
  return readOrders().find((o) => o.reference === reference) || null;
}
function findOrderById(orderId) {
  return readOrders().find((o) => o.orderId === orderId) || null;
}

function sign(secret, rawBody) {
  return crypto.createHmac("sha512", secret).update(rawBody).digest("hex");
}
function safeCompare(a, b) {
  const bufA = Buffer.from(a || "", "utf8");
  const bufB = Buffer.from(b || "", "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
function newOrderId() {
  return "DLX-" + Date.now().toString(36).toUpperCase() + "-" + crypto.randomBytes(2).toString("hex").toUpperCase();
}

// Capture the exact raw body text for webhook signature verification.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  })
);

// ---- Checkout: called by the browser when someone taps Buy Now ----------
app.post("/api/checkout", async (req, res) => {
  try {
    if (!HUB_URL || !HUB_API_KEY || !HUB_API_SECRET) {
      return res.status(503).json({
        ok: false,
        message:
          "Payments aren't configured on this deployment yet. Set HUB_URL, HUB_API_KEY, HUB_API_SECRET and SITE_URL in Railway variables.",
      });
    }

    const { productName, productId, variationId, attributes, unitPrice, quantity, name, phone, email } = req.body || {};

    const qty = Math.max(1, parseInt(quantity, 10) || 1);
    const price = Number(unitPrice);

    if (!productName || !Number.isFinite(price) || price <= 0) {
      return res.status(400).json({ ok: false, message: "Missing or invalid product/price." });
    }
    if (!name || !String(name).trim()) {
      return res.status(400).json({ ok: false, message: "Please enter your name." });
    }
    const phoneDigits = String(phone || "").replace(/\D/g, "");
    if (phoneDigits.length < 9) {
      return res.status(400).json({ ok: false, message: "Please enter a valid phone number to receive the data bundle." });
    }

    const customerEmail =
      (email && String(email).trim()) || `${phoneDigits}@no-email.datalix.gh`;

    const amount = Math.round(price * qty * 100) / 100; // GHS, 2dp

    const orderId = newOrderId();
    const redirectUrl = `${SITE_URL || ""}/order/${orderId}/thank-you`;

    const body = {
      email: customerEmail,
      amount,
      currency: "GHS",
      redirectUrl,
      metadata: {
        orderId,
        productName,
        productId,
        variationId,
        attributes,
        quantity: qty,
        phone: phoneDigits,
        customerName: name,
      },
    };
    const raw = JSON.stringify(body);
    const signature = sign(HUB_API_SECRET, raw);

    const hubResp = await fetch(`${HUB_URL}/api/v1/transaction/initialize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": HUB_API_KEY,
        "x-signature": signature,
      },
      body: raw,
    });
    const hubData = await hubResp.json();

    if (!hubResp.ok || !hubData.status) {
      return res.status(502).json({ ok: false, message: hubData.message || "Payment gateway rejected the request." });
    }

    saveOrder({
      orderId,
      reference: hubData.data.reference,
      productName,
      productId: productId || null,
      variationId: variationId || null,
      attributes: attributes || null,
      quantity: qty,
      unitPrice: price,
      amount,
      currency: "GHS",
      customerName: name,
      phone: phoneDigits,
      email: customerEmail,
      status: "PENDING",
      createdAt: new Date().toISOString(),
    });

    res.json({ ok: true, authorizationUrl: hubData.data.authorizationUrl, orderId });
  } catch (err) {
    console.error("checkout error:", err);
    res.status(500).json({ ok: false, message: "Something went wrong starting your payment. Please try again." });
  }
});

// ---- Where the hub sends the customer back after paying -----------------
app.get("/order/:orderId/thank-you", async (req, res) => {
  const { orderId } = req.params;
  let order = findOrderById(orderId);

  if (!order) {
    return res.status(404).send(renderThankYou({ status: "NOT_FOUND" }));
  }

  // Re-verify with the hub directly rather than trusting the URL's ?status= alone.
  if (HUB_URL && HUB_API_KEY && HUB_API_SECRET && order.reference) {
    try {
      const signature = sign(HUB_API_SECRET, "");
      const verifyResp = await fetch(`${HUB_URL}/api/v1/transaction/verify/${order.reference}`, {
        headers: { "x-api-key": HUB_API_KEY, "x-signature": signature },
      });
      const verifyData = await verifyResp.json();
      if (verifyResp.ok && verifyData.status) {
        order = updateOrder(orderId, { status: verifyData.data.status }) || order;
      }
    } catch (err) {
      console.error("verify error:", err);
    }
  }

  res.send(renderThankYou(order));
});

function renderThankYou(order) {
  const status = order.status || "PENDING";
  const isSuccess = status === "SUCCESS";
  const isFailed = status === "FAILED" || status === "ABANDONED";
  const title =
    order.status === "NOT_FOUND" ? "Order not found" : isSuccess ? "Payment received!" : isFailed ? "Payment not completed" : "Payment pending";
  const color = isSuccess ? "#1a7f37" : isFailed ? "#c0392b" : "#a5750c";
  const message =
    order.status === "NOT_FOUND"
      ? "We couldn't find that order. If you were charged, contact support with your Paystack reference."
      : isSuccess
      ? `Thanks${order.customerName ? ", " + escapeHtml(order.customerName) : ""}! We've received your payment for <strong>${escapeHtml(
          order.productName || "your order"
        )}</strong>. Your data bundle will be sent to <strong>${escapeHtml(order.phone || "your number")}</strong> shortly.`
      : isFailed
      ? "Your payment didn't go through. No data bundle has been sent. You can go back and try again."
      : "We're still confirming your payment with Paystack. This page will show the final status shortly — you can refresh in a minute.";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${title} — Datalix</title>
<style>
  body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f6f5fb;margin:0;padding:40px 16px;color:#22223a;}
  .card{max-width:520px;margin:0 auto;background:#fff;border-radius:14px;padding:32px;box-shadow:0 4px 24px rgba(30,20,60,.08);}
  h1{font-size:22px;margin:0 0 12px;color:${color};}
  p{line-height:1.6;font-size:15px;}
  .ref{font-family:monospace;background:#f0eefc;padding:2px 8px;border-radius:6px;}
  a.btn{display:inline-block;margin-top:20px;background:#3f2e94;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;}
</style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <p>${message}</p>
    ${order.reference ? `<p>Reference: <span class="ref">${escapeHtml(order.reference)}</span></p>` : ""}
    <a class="btn" href="/">Back to Datalix</a>
  </div>
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---- Webhook from the Payment Hub (server-to-server, signed) ------------
app.post("/webhooks/hub", (req, res) => {
  try {
    const signature = req.header("x-hub-signature");
    if (!HUB_API_SECRET || !signature || !safeCompare(signature, sign(HUB_API_SECRET, req.rawBody || ""))) {
      return res.status(401).json({ ok: false, message: "Invalid signature" });
    }
    const { reference, status } = req.body || {};
    const order = findOrderByReference(reference);
    if (order) {
      updateOrder(order.orderId, { status: status === "SUCCESS" ? "SUCCESS" : "FAILED" });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("webhook error:", err);
    res.status(500).json({ ok: false });
  }
});

// ---- Basic admin view so you know who to send bundles to ----------------
app.get("/admin/orders", (req, res) => {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) {
    return res.status(401).send("Unauthorized. Append ?key=YOUR_ADMIN_KEY to the URL.");
  }
  const orders = readOrders().slice().reverse();
  const rows = orders
    .map(
      (o) => `<tr>
        <td>${escapeHtml(o.createdAt || "")}</td>
        <td>${escapeHtml(o.orderId)}</td>
        <td>${escapeHtml(o.productName)}${o.attributes ? " — " + escapeHtml(JSON.stringify(o.attributes)) : ""}</td>
        <td>${escapeHtml(o.customerName)}</td>
        <td>${escapeHtml(o.phone)}</td>
        <td>GHS ${escapeHtml(o.amount)}</td>
        <td style="font-weight:600;color:${o.status === "SUCCESS" ? "#1a7f37" : o.status === "FAILED" ? "#c0392b" : "#a5750c"}">${escapeHtml(
          o.status
        )}</td>
        <td>${escapeHtml(o.reference || "")}</td>
      </tr>`
    )
    .join("");
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Orders — Datalix Admin</title>
  <style>body{font-family:sans-serif;padding:24px;background:#f6f5fb;}table{border-collapse:collapse;width:100%;background:#fff;}
  th,td{padding:8px 12px;border-bottom:1px solid #eee;font-size:13px;text-align:left;}th{background:#3f2e94;color:#fff;}</style>
  </head><body><h2>Datalix — Orders (${orders.length})</h2>
  <table><thead><tr><th>Date</th><th>Order ID</th><th>Product</th><th>Customer</th><th>Phone</th><th>Amount</th><th>Status</th><th>Reference</th></tr></thead>
  <tbody>${rows}</tbody></table></body></html>`);
});

// ---- Static files ---------------------------------------------------------
app.use(express.static(__dirname, { extensions: ["html"] }));

// WordPress-style URLs had no .html extension in links like "mtn-data-bundles/"
// This lets "/mtn-data-bundles/" resolve to "/mtn-data-bundles/index.html"
app.get("*", (req, res, next) => {
  const target = path.join(__dirname, req.path, "index.html");
  // Only resolve this way if that exact file exists — otherwise fall through to
  // a real 404 instead of silently rendering the homepage at the wrong URL
  // (which used to break every relative asset on the page).
  fs.access(target, fs.constants.F_OK, (err) => {
    if (err) return next();
    res.sendFile(target);
  });
});

app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, "404.html"));
});

app.listen(PORT, () => {
  console.log(`Datalix site running on port ${PORT}`);
  if (!HUB_URL || !HUB_API_KEY || !HUB_API_SECRET || !SITE_URL) {
    console.warn(
      "⚠️  Payments not fully configured — set HUB_URL, HUB_API_KEY, HUB_API_SECRET, SITE_URL, ADMIN_KEY in your environment."
    );
  }
});
