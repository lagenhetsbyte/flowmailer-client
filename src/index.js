import axios from 'axios';

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
    this.userAgent = opts.userAgent ?? 'flowmailer-client/1.x (axios)';

    this._token = '';
    this._expiresAt = 0;
    this._inflightRefresh = null;

    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: this.timeoutMs,
      headers: {
        Accept: 'application/vnd.flowmailer.v1.12+json;charset=UTF-8',
        'Content-Type': 'application/vnd.flowmailer.v1.12+json;charset=UTF-8',
        'User-Agent': this.userAgent,
      },
      validateStatus: () => true,
    });

    this.http.interceptors.response.use(
      (resp) => resp,
      async (error) => {
        throw error;
      }
    );
  }

  _mustRenew() {
    return (
      !this._token ||
      !this._expiresAt ||
      Date.now() + this.graceMs >= this._expiresAt
    );
  }

  async _updateAccessToken() {
    const form = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: 'client_credentials',
    });

    const resp = await axios.post(this.loginUrl, form.toString(), {
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': this.userAgent,
      },
      timeout: this.timeoutMs,
      validateStatus: () => true,
    });

    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(
        `Token fetch error: ${resp.status} ${resp.statusText || ""}`
      );
    }

    const { access_token, expires_in } = resp.data ?? {};
    if (!access_token || !expires_in) {
      throw new Error('Couldnt get access_token from Flowmailer');
    }

    this._token = access_token;
    this._expiresAt = Date.now() + Number(expires_in) * 1000;

    this.http.defaults.headers.common.Authorization = `Bearer ${this._token}`;
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

  _buildPayload({
    toMail,
    subject,
    flowSelector,
    data,
    from,
    attachments,
    text,
  }) {
    const payload = {
      headerFromAddress: from.email,
      headerFromName: from.name,
      messageType: 'EMAIL',
      recipientAddress: toMail,
      senderAddress: from.email,
      subject,
    };

    if (text) {
      payload.text = text;
    } else {
      payload.flowSelector = flowSelector;
      payload.data = data;
    }

    if (attachments?.length) {
      payload.attachments = attachments;
    }
    return payload;
  }

  async sendEmail({
    toMail,
    subject,
    flowSelector,
    data = {},
    from,
    attachments = [],
    text = '',
  }) {
    if (!toMail) throw new Error('toMail required');
    if (!subject) throw new Error('subject required');
    if (!from?.email || !from?.name)
      throw new Error('Missing from.email or from.name');

    await this.getAccessToken();

    const payload = this._buildPayload({
      toMail,
      subject,
      flowSelector,
      data,
      from,
      attachments,
      text,
    });

    const attempt = async () => {
      const resp = await this.http.post("/messages/submit", payload);
      return resp;
    };

    let resp = await attempt();

    if (resp.status === 401) {
      await this.forceRefresh();
      resp = await attempt();
    }

    let retries = 0;
    while (
      resp.status !== 202 &&
      (resp.status === 429 || resp.status >= 500) &&
      retries < this.maxRetries
    ) {
      const backoff = 200 * Math.pow(2, retries); // 200ms, 400ms, ...
      await new Promise((r) => setTimeout(r, backoff));
      resp = await attempt();
      retries++;
    }

    if (resp.status < 200 || resp.status >= 300) {
      // Låt oss läsa ev. body för felsökning; axios har redan gjort parsing
      const body =
        typeof resp.data === 'string'
          ? resp.data
          : JSON.stringify(resp.data ?? {});
      throw new Error(
        `sendEmail error: ${resp.status} ${resp.statusText || ''}${
          body ? ` — ${body.slice(0, 300)}` : ''
        }`
      );
    }

    return true;
  }


}
