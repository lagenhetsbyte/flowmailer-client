export default class FlowmailerClient {
  constructor(cfg, opts = {}) {
    const { accountId, clientId, clientSecret } = cfg ?? {};
    if (!accountId || !clientId || !clientSecret) {
      throw new Error(
        'Flowmailer missing config (accountId, clientId, clientSecret)'
      );
    }

    this.accountId = accountId;
    this.clientId = clientId;
    this.clientSecret = clientSecret;

    this.graceMs = opts.graceMs ?? 5000;
    this.timeoutMs = opts.timeoutMs ?? 15000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.baseUrl =
      opts.baseUrl ?? `https://api.flowmailer.net/${this.accountId}`;
    this.loginUrl = opts.loginUrl ?? 'https://login.flowmailer.net/oauth/token';
    this.userAgent = opts.userAgent ?? 'flowmailer-client/1.x (node-fetch)';

    this._token = '';
    this._expiresAt = 0;
    this._inflightRefresh = null;
  }

  _mustRenew() {
    return (
      !this._token ||
      !this._expiresAt ||
      Date.now() + this.graceMs >= this._expiresAt
    );
  }

  async _fetchWithTimeout(url, init = {}) {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      return await fetch(url, { ...init, signal: ctrl.signal });
    } finally {
      clearTimeout(id);
    }
  }

  async _updateAccessToken() {
    const form = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: 'client_credentials',
    }).toString();

    const resp = await this._fetchWithTimeout(this.loginUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': this.userAgent,
      },
      body: form,
    });

    if (!resp.ok) {
      throw new Error(`Token fetch error: ${resp.status} ${resp.statusText}`);
    }

    const { access_token, expires_in } = await resp.json();
    if (!access_token || !expires_in) {
      throw new Error('Couldnt get access_token from Flowmailer');
    }

    this._token = access_token;
    this._expiresAt = Date.now() + Number(expires_in) * 1000;
    return this._token;
  }

  async forceRefresh() {
    if (!this._inflightRefresh) {
      this._inflightRefresh = this._updateAccessToken().finally(() => {
        this._inflightRefresh = null;
      });
    }
    return this._inflightRefresh;
  }

  async getAccessToken() {
    if (this._mustRenew()) {
      return this.forceRefresh();
    }
    return this._token;
  }

  async sendEmail({
    toMail,
    subject,
    flowSelector,
    data = {},
    from,
    attachments = [],
  }) {
    if (!toMail) {
      throw new Error('toMail required');
    }
    if (!subject) {
      throw new Error('subject required');
    }
    if (!from?.email || !from?.name) {
      throw new Error('Missing from.email or from.name');
    }

    const attempt = async (bearerToken) => {
      const resp = await this._fetchWithTimeout(
        `${this.baseUrl}/messages/submit`,
        {
          method: 'POST',
          headers: {
            Accept: 'application/vnd.flowmailer.v1.12+json;charset=UTF-8',
            'Content-Type':
              'application/vnd.flowmailer.v1.12+json;charset=UTF-8',
            Authorization: `Bearer ${bearerToken}`,
            'User-Agent': this.userAgent,
          },
          body: JSON.stringify({
            headerFromAddress: from.email,
            headerFromName: from.name,
            messageType: 'EMAIL',
            recipientAddress: toMail,
            senderAddress: from.email,
            flowSelector,
            subject,
            data,
            attachments,
          }),
        }
      );
      return resp;
    };

    let token = await this.getAccessToken();
    let resp = await attempt(token);

    if (resp.status === 401) {
      await this.forceRefresh();
      token = await this.getAccessToken();
      resp = await attempt(token);
    }

    let retries = 0;
    while (
      !resp.ok &&
      (resp.status === 429 || resp.status >= 500) &&
      retries < this.maxRetries
    ) {
      const backoff = 200 * Math.pow(2, retries);
      await new Promise((r) => setTimeout(r, backoff));
      resp = await attempt(token);
      retries++;
    }

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(
        `sendEmail error: ${resp.status} ${resp.statusText}${
          body ? ` — ${body.slice(0, 300)}` : ''
        }`
      );
    }

    return true;
  }

  async ping() {
    const token = await this.getAccessToken();
    const resp = await this._fetchWithTimeout(
      `${this.baseUrl}/accounts/${this.accountId}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': this.userAgent,
          Accept: 'application/json',
        },
      }
    );
    return resp.ok;
  }
}
