import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { logger } from "./logger.js";

/**
 * Route Node's built-in fetch() through an HTTP/HTTPS proxy when the standard
 * env vars (HTTPS_PROXY / HTTP_PROXY / NO_PROXY, lower-case variants honored)
 * are set. Node's native fetch ignores those vars by default — undici's
 * EnvHttpProxyAgent reads them and applies the right routing per request.
 *
 * If a corporate proxy does TLS MITM, also set NODE_EXTRA_CA_CERTS to the
 * trust bundle so the TLS handshake from Node to the proxy succeeds. That
 * variable is read directly by Node at startup; nothing to do here.
 *
 * Call this once from each entry-point (api server + ingest worker) BEFORE
 * any outbound fetch() runs.
 */
export function installProxyDispatcher(): void {
  const httpsProxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? "";
  const httpProxy = process.env.HTTP_PROXY ?? process.env.http_proxy ?? "";
  if (!httpsProxy && !httpProxy) return;

  setGlobalDispatcher(new EnvHttpProxyAgent());
  logger.info(
    {
      https_proxy: httpsProxy ? redactProxyUrl(httpsProxy) : null,
      http_proxy: httpProxy ? redactProxyUrl(httpProxy) : null,
      no_proxy: process.env.NO_PROXY ?? process.env.no_proxy ?? null,
      extra_ca: process.env.NODE_EXTRA_CA_CERTS ?? null,
    },
    "outbound HTTP proxy active for native fetch()"
  );
}

// Strip user:pass from the proxy URL before logging.
function redactProxyUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.username || u.password) {
      u.username = u.username ? "***" : "";
      u.password = u.password ? "***" : "";
    }
    return u.toString();
  } catch {
    return "<unparseable>";
  }
}
