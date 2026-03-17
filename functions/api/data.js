/**
 * BTC Arbitrage Monitor — Cloudflare Worker
 * Proxy público hacia Binance FAPI (USDT-M futures)
 * Sin API key requerida. Copiá y pegá esto en el editor de Workers.
 *
 * Query params:
 *   ?perp=BTCUSDT
 *   ?quarterly=BTCUSDT_250627
 */

const FAPI = "https://fapi.binance.com/fapi/v1";
const DAPI = "https://dapi.binance.com/dapi/v1";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json",
};

export default {
  async fetch(request, env, ctx) {

    // Preflight CORS
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    const url       = new URL(request.url);
    const perp      = (url.searchParams.get("perp")      || "BTCUSDT").toUpperCase();
    const quarterly = (url.searchParams.get("quarterly") || "BTCUSDT_250627").toUpperCase();

    // COIN-M (dapi) si empieza con BTCUSD_ o ETHUSD_
    const isCoinM = quarterly.startsWith("BTCUSD_") || quarterly.startsWith("ETHUSD_");
    const qAPI    = isCoinM ? DAPI : FAPI;

    try {
      // ── 5 llamadas paralelas a Binance ──────────────────────────────────────
      const [
        perpTicker,
        qtrTicker,
        perpKline1h,
        perpKline24h,
        fundingInfo,
      ] = await Promise.all([
        fetch(`${FAPI}/premiumIndex?symbol=${perp}`)
          .then(r => r.json()),

        fetch(`${qAPI}/premiumIndex?symbol=${quarterly}`)
          .then(r => r.json()),

        // 2 velas de 1h → cambio porcentual en la última hora
        fetch(`${FAPI}/klines?symbol=${perp}&interval=1h&limit=2`)
          .then(r => r.json()),

        // 2 velas de 1d → cambio porcentual en 24h
        fetch(`${FAPI}/klines?symbol=${perp}&interval=1d&limit=2`)
          .then(r => r.json()),

        // Funding rate histórico (último registro)
        fetch(`${FAPI}/fundingRate?symbol=${perp}&limit=1`)
          .then(r => r.json()),
      ]);

      // ── Precios ─────────────────────────────────────────────────────────────
      const perpPrice = parseFloat(perpTicker.markPrice || perpTicker.indexPrice || 0);

      // qtrTicker puede ser objeto o array según el endpoint
      const qtrRaw    = Array.isArray(qtrTicker) ? qtrTicker[0] : qtrTicker;
      const qtrPrice  = parseFloat(qtrRaw?.markPrice || qtrRaw?.indexPrice || 0);

      // ── Funding ─────────────────────────────────────────────────────────────
      // lastFundingRate viene en decimal (ej: 0.0001) → convertimos a %
      const fundingRate     = parseFloat(perpTicker.lastFundingRate || 0) * 100;
      const nextFundingTime = parseInt(perpTicker.nextFundingTime   || 0);
      const fundingDaily    = fundingRate * 3;

      // ── Basis ────────────────────────────────────────────────────────────────
      const basisUSD = qtrPrice - perpPrice;
      const basisPct = perpPrice > 0 ? (basisUSD / perpPrice) * 100 : 0;

      // ── Retorno estimado ─────────────────────────────────────────────────────
      const estimatedReturn = basisPct + fundingDaily;

      // ── Cambio 1H ────────────────────────────────────────────────────────────
      // klines: [openTime, open, high, low, CLOSE, volume, ...]
      let change1h = 0;
      if (Array.isArray(perpKline1h) && perpKline1h.length >= 2) {
        const prev = parseFloat(perpKline1h[0][4]);
        const last = parseFloat(perpKline1h[1][4]);
        if (prev > 0) change1h = ((last - prev) / prev) * 100;
      }

      // ── Cambio 24H ───────────────────────────────────────────────────────────
      let change24h = 0;
      if (Array.isArray(perpKline24h) && perpKline24h.length >= 2) {
        const prev = parseFloat(perpKline24h[0][4]);
        const last = parseFloat(perpKline24h[1][4]);
        if (prev > 0) change24h = ((last - prev) / prev) * 100;
      }

      // ── Tiempo hasta próximo funding ─────────────────────────────────────────
      const now           = Date.now();
      const msUntilFund   = Math.max(0, nextFundingTime - now);
      const minsUntilFund = Math.floor(msUntilFund / 60000);
      const hFund         = Math.floor(minsUntilFund / 60);
      const mFund         = minsUntilFund % 60;
      const nextFundingStr = `${String(hFund).padStart(2,"0")}h ${String(mFund).padStart(2,"0")}m`;

      // ── Días hasta vencimiento ───────────────────────────────────────────────
      // Formato símbolo: BTCUSDT_YYMMDD  →  extrae fecha del sufijo
      let daysToExpiry = null;
      const match = quarterly.match(/(\d{6})$/);
      if (match) {
        const d       = match[1]; // YYMMDD
        const expDate = new Date(
          `20${d.slice(0,2)}-${d.slice(2,4)}-${d.slice(4,6)}T08:00:00Z`
        );
        daysToExpiry = Math.max(0, Math.ceil((expDate - now) / 86_400_000));
      }

      // ── Alertas ──────────────────────────────────────────────────────────────
      const alerts = [];
      if (basisPct < 3)               alerts.push("BASIS_LOW");
      if (Math.abs(change1h)  >= 10)  alerts.push("EXTREME_MOVE_1H");
      if (Math.abs(change24h) >= 20)  alerts.push("EXTREME_MOVE_24H");

      // ── Payload final ────────────────────────────────────────────────────────
      const payload = {
        timestamp: new Date().toISOString(),
        config:  { perp, quarterly },
        prices:  { perpetual: perpPrice, quarterly: qtrPrice },
        basis:   { usd: basisUSD, pct: basisPct },
        funding: {
          rate:          fundingRate,
          daily:         fundingDaily,
          nextFunding:   nextFundingStr,
          nextFundingMs: msUntilFund,
        },
        returns:  { estimated: estimatedReturn },
        market:   { change1h, change24h },
        expiry:   { daysToExpiry, symbol: quarterly },
        status: {
          alerts,
          isAlert: alerts.length > 0,
          color:   alerts.length > 0 ? "RED" : "GREEN",
        },
      };

      return new Response(JSON.stringify(payload, null, 2), {
        status:  200,
        headers: { ...CORS, "Cache-Control": "no-store" },
      });

    } catch (err) {
      return new Response(
        JSON.stringify({ error: true, message: err.message }),
        { status: 500, headers: CORS }
      );
    }
  }
};
