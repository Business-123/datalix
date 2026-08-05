(function () {
  "use strict";

  function money(n) {
    return "GHS " + Number(n).toFixed(2);
  }

  function getProductName(form) {
    var summary = form.closest(".summary, .entry-summary") || document;
    var h1 = summary.querySelector("h1.product_title, h1.entry-title") || document.querySelector("h1.product_title");
    return h1 ? h1.textContent.trim() : document.title;
  }

  function getSimplePrice(form) {
    var summary = form.closest(".summary, .entry-summary") || document;
    var amount = summary.querySelector(".price .amount bdi") || summary.querySelector(".price .amount");
    if (!amount) return null;
    var text = amount.textContent.replace(/[^0-9.]/g, "");
    var val = parseFloat(text);
    return Number.isFinite(val) ? val : null;
  }

  function wireVariationForm(form) {
    var variationsRaw = form.getAttribute("data-product_variations");
    var variations = [];
    try {
      variations = JSON.parse(variationsRaw || "[]");
    } catch (e) {
      variations = [];
    }

    var selects = Array.prototype.slice.call(form.querySelectorAll('select[name^="attribute_"]'));
    var selected = null;

    function currentAttributes() {
      var attrs = {};
      selects.forEach(function (s) {
        attrs[s.name] = s.value;
      });
      return attrs;
    }

    function findMatch() {
      var attrs = currentAttributes();
      var keys = Object.keys(attrs).filter(function (k) {
        return attrs[k];
      });
      if (keys.length !== selects.length) {
        selected = null;
        return;
      }
      selected =
        variations.find(function (v) {
          return keys.every(function (k) {
            return v.attributes[k] === attrs[k];
          });
        }) || null;
    }

    selects.forEach(function (s) {
      s.addEventListener("change", findMatch);
    });

    // Swatch UI (cfvsw plugin) usually needs its own JS which isn't running in
    // this static export — wire clicks directly to the underlying <select>.
    var swatchContainers = form.querySelectorAll(".cfvsw-swatches-container");
    swatchContainers.forEach(function (container) {
      var attrName = "attribute_" + container.getAttribute("swatches-attr").replace(/^attribute_/, "");
      var select = form.querySelector('select[name="' + attrName + '"]') || form.querySelector('select[data-attribute_name="' + attrName + '"]');
      container.querySelectorAll(".cfvsw-swatches-option").forEach(function (opt) {
        opt.addEventListener("click", function () {
          container.querySelectorAll(".cfvsw-swatches-option").forEach(function (o) {
            o.classList.remove("dlx-selected");
          });
          opt.classList.add("dlx-selected");
          if (select) {
            select.value = opt.getAttribute("data-slug");
            select.dispatchEvent(new Event("change"));
          }
        });
      });
    });

    return {
      getSelection: function () {
        findMatch();
        return selected;
      },
    };
  }

  function openCheckoutModal(details) {
    var existing = document.getElementById("dlx-checkout-overlay");
    if (existing) existing.remove();

    var overlay = document.createElement("div");
    overlay.id = "dlx-checkout-overlay";
    overlay.innerHTML =
      '<div class="dlx-modal">' +
      '<button class="dlx-close" aria-label="Close">&times;</button>' +
      "<h2>Checkout</h2>" +
      '<p class="dlx-line"><strong>' + escapeHtml(details.productName) + (details.variationLabel ? " — " + escapeHtml(details.variationLabel) : "") + "</strong></p>" +
      '<p class="dlx-line dlx-total">Total: <span id="dlx-total">' + money(details.unitPrice * details.quantity) + "</span></p>" +
      '<label>Your name<input id="dlx-name" type="text" placeholder="Full name" required /></label>' +
      '<label>Number to receive the bundle<input id="dlx-phone" type="tel" placeholder="e.g. 0551234567" required /></label>' +
      '<label>Email <span class="dlx-optional">(for your payment receipt)</span><input id="dlx-email" type="email" placeholder="you@example.com" /></label>' +
      '<label>Quantity<input id="dlx-qty" type="number" min="1" value="' + details.quantity + '" /></label>' +
      '<div id="dlx-error" class="dlx-error" hidden></div>' +
      '<button id="dlx-pay" class="dlx-pay-btn">Pay ' + money(details.unitPrice * details.quantity) + "</button>" +
      '<p class="dlx-note">You\'ll be taken to Paystack\'s secure checkout to pay by card or Mobile Money.</p>' +
      "</div>";
    document.body.appendChild(overlay);
    injectStyles();

    overlay.querySelector(".dlx-close").addEventListener("click", function () {
      overlay.remove();
    });
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) overlay.remove();
    });

    var qtyInput = overlay.querySelector("#dlx-qty");
    var totalEl = overlay.querySelector("#dlx-total");
    var payBtn = overlay.querySelector("#dlx-pay");
    function refreshTotal() {
      var qty = Math.max(1, parseInt(qtyInput.value, 10) || 1);
      var total = details.unitPrice * qty;
      totalEl.textContent = money(total);
      payBtn.textContent = "Pay " + money(total);
    }
    qtyInput.addEventListener("input", refreshTotal);

    payBtn.addEventListener("click", function () {
      var errorEl = overlay.querySelector("#dlx-error");
      errorEl.hidden = true;

      var name = overlay.querySelector("#dlx-name").value.trim();
      var phone = overlay.querySelector("#dlx-phone").value.trim();
      var email = overlay.querySelector("#dlx-email").value.trim();
      var qty = Math.max(1, parseInt(qtyInput.value, 10) || 1);

      if (!name) return showError("Please enter your name.");
      if (phone.replace(/\D/g, "").length < 9) return showError("Please enter a valid phone number.");

      payBtn.disabled = true;
      payBtn.textContent = "Starting payment…";

      fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productName: details.productName,
          productId: details.productId,
          variationId: details.variationId,
          attributes: details.attributes,
          unitPrice: details.unitPrice,
          quantity: qty,
          name: name,
          phone: phone,
          email: email,
        }),
      })
        .then(function (r) {
          return r.json().then(function (data) {
            return { ok: r.ok, data: data };
          });
        })
        .then(function (res) {
          if (!res.ok || !res.data.ok) {
            throw new Error(res.data.message || "Could not start payment.");
          }
          window.location.href = res.data.authorizationUrl;
        })
        .catch(function (err) {
          showError(err.message);
          payBtn.disabled = false;
          refreshTotal();
        });

      function showError(msg) {
        errorEl.textContent = msg;
        errorEl.hidden = false;
        payBtn.disabled = false;
        refreshTotal();
      }
    });
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  var stylesInjected = false;
  function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    var style = document.createElement("style");
    style.textContent =
      "#dlx-checkout-overlay{position:fixed;inset:0;background:rgba(20,15,40,.55);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px;}" +
      ".dlx-modal{background:#fff;border-radius:14px;max-width:380px;width:100%;padding:24px;position:relative;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;box-shadow:0 10px 40px rgba(0,0,0,.25);max-height:90vh;overflow-y:auto;}" +
      ".dlx-modal h2{margin:0 0 12px;font-size:20px;color:#2e294e;}" +
      ".dlx-close{position:absolute;top:12px;right:14px;background:none;border:none;font-size:24px;line-height:1;cursor:pointer;color:#888;}" +
      ".dlx-line{margin:4px 0;font-size:14px;color:#333;}" +
      ".dlx-total{font-size:16px;color:#2e294e;}" +
      ".dlx-modal label{display:block;margin-top:14px;font-size:13px;font-weight:600;color:#444;}" +
      ".dlx-optional{font-weight:400;color:#999;}" +
      ".dlx-modal input{display:block;width:100%;margin-top:6px;padding:10px 12px;border:1px solid #ddd;border-radius:8px;font-size:15px;box-sizing:border-box;}" +
      ".dlx-pay-btn{margin-top:18px;width:100%;background:#2e294e;color:#fff;border:none;padding:13px;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;}" +
      ".dlx-pay-btn:disabled{opacity:.6;cursor:default;}" +
      ".dlx-error{margin-top:12px;background:#fdecea;color:#c0392b;padding:10px 12px;border-radius:8px;font-size:13px;}" +
      ".dlx-note{margin-top:12px;font-size:12px;color:#888;text-align:center;}" +
      ".cfvsw-swatches-option.dlx-selected{outline:2px solid #2e294e;outline-offset:1px;}";
    document.head.appendChild(style);
  }

  function init() {
    var forms = document.querySelectorAll("form.cart");
    forms.forEach(function (form) {
      var productId = form.getAttribute("data-product_id") || (form.querySelector('input[name="product_id"]') || {}).value || "";
      var isVariable = form.classList.contains("variations_form");
      var variationApi = isVariable ? wireVariationForm(form) : null;

      form.addEventListener("submit", function (e) {
        e.preventDefault();

        var productName = getProductName(form);
        var quantity = parseInt((form.querySelector('input[name="quantity"]') || {}).value, 10) || 1;

        if (isVariable) {
          var selection = variationApi.getSelection();
          if (!selection) {
            alert("Please choose an option first.");
            return;
          }
          var attrLabel = Object.values(selection.attributes)
            .map(function (v) {
              return String(v).replace(/-/g, " ").toUpperCase();
            })
            .join(", ");
          openCheckoutModal({
            productName: productName,
            productId: productId,
            variationId: selection.variation_id,
            attributes: selection.attributes,
            variationLabel: attrLabel,
            unitPrice: selection.display_price,
            quantity: quantity,
          });
        } else {
          var price = getSimplePrice(form);
          if (!price) {
            alert("Sorry, we couldn't read the price for this product. Please contact support.");
            return;
          }
          openCheckoutModal({
            productName: productName,
            productId: productId,
            variationId: null,
            attributes: null,
            variationLabel: null,
            unitPrice: price,
            quantity: quantity,
          });
        }
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
