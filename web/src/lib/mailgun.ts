const MAILGUN_API_BASE = "https://api.mailgun.net/v3";

interface MailgunMessageResponse {
  id: string;
  message: string;
}

interface SendEmailParams {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  from?: string;
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string;
  tags?: string[];
}

interface SendTemplateEmailParams {
  to: string | string[];
  subject: string;
  template: string;
  templateVariables?: Record<string, string>;
  from?: string;
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string;
  tags?: string[];
}

function getMailgunConfig(): { apiKey: string; domain: string } {
  const apiKey = process.env.MAILGUN_API_KEY;
  if (!apiKey) {
    throw new Error("MAILGUN_API_KEY environment variable is not set");
  }

  const domain = process.env.MAILGUN_DOMAIN ?? "email.vellum.ai";

  return { apiKey, domain };
}

function buildFormData(
  params: SendEmailParams | SendTemplateEmailParams,
  domain: string,
): FormData {
  const formData = new FormData();

  const from = params.from ?? `noreply@${domain}`;
  formData.append("from", from);

  const toList = Array.isArray(params.to) ? params.to : [params.to];
  for (const recipient of toList) {
    formData.append("to", recipient);
  }

  formData.append("subject", params.subject);

  if (params.cc) {
    const ccList = Array.isArray(params.cc) ? params.cc : [params.cc];
    for (const recipient of ccList) {
      formData.append("cc", recipient);
    }
  }

  if (params.bcc) {
    const bccList = Array.isArray(params.bcc) ? params.bcc : [params.bcc];
    for (const recipient of bccList) {
      formData.append("bcc", recipient);
    }
  }

  if (params.replyTo) {
    formData.append("h:Reply-To", params.replyTo);
  }

  if (params.tags) {
    for (const tag of params.tags) {
      formData.append("o:tag", tag);
    }
  }

  return formData;
}

export async function sendEmail(
  params: SendEmailParams,
): Promise<MailgunMessageResponse> {
  const { apiKey, domain } = getMailgunConfig();

  const formData = buildFormData(params, domain);

  if (params.text) {
    formData.append("text", params.text);
  }

  if (params.html) {
    formData.append("html", params.html);
  }

  const response = await fetch(`${MAILGUN_API_BASE}/${domain}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`api:${apiKey}`)}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Mailgun send failed (${response.status}): ${errorBody}`
    );
  }

  return response.json() as Promise<MailgunMessageResponse>;
}

export async function sendTemplateEmail(
  params: SendTemplateEmailParams,
): Promise<MailgunMessageResponse> {
  const { apiKey, domain } = getMailgunConfig();

  const formData = buildFormData(params, domain);

  formData.append("template", params.template);

  if (params.templateVariables) {
    formData.append(
      "h:X-Mailgun-Variables",
      JSON.stringify(params.templateVariables),
    );
  }

  const response = await fetch(`${MAILGUN_API_BASE}/${domain}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`api:${apiKey}`)}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Mailgun template send failed (${response.status}): ${errorBody}`
    );
  }

  return response.json() as Promise<MailgunMessageResponse>;
}
