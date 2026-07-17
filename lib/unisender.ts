type SendEmailParams = {
  to: string;
  subject: string;
  html: string;
  emailType: "verification" | "password_reset";
};

type UniSenderRecipientResult = {
  index?: number;
  email?: string;
  id?: string;
  errors?: Array<{
    code?: string;
    message?: string;
  }>;
};

type UniSenderResponse = {
  result?: UniSenderRecipientResult[];
  error?: string;
  code?: string;
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export async function sendEmail({
  to,
  subject,
  html,
  emailType,
}: SendEmailParams): Promise<string> {
  const apiKey = process.env.UNISENDER_API_KEY;
  const senderEmail =
    process.env.UNISENDER_FROM_EMAIL || "info@platformaekspertov.ru";
  const senderName =
    process.env.UNISENDER_FROM_NAME || "Платформа судебных экспертов";
  const listId = process.env.UNISENDER_LIST_ID;

  if (!apiKey) {
    throw new Error("UNISENDER_API_KEY is not configured");
  }

  if (!listId) {
    throw new Error("UNISENDER_LIST_ID is not configured");
  }

  const form = new URLSearchParams({
    api_key: apiKey,
    email: to.trim().toLowerCase(),
    sender_email: senderEmail,
    sender_name: senderName,
    subject,
    body: html,
    list_id: listId,
    lang: "ru",
    error_checking: "1",
    track_read: "0",
    track_links: "0",
  });

  console.info(`[EMAIL] ${emailType} start`, {
    recipientDomain: to.split("@")[1] || "unknown",
  });

  const response = await fetch(
    "https://api.unisender.com/ru/api/sendEmail?format=json",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
      cache: "no-store",
    }
  );

  const rawText = await response.text();

  let data: UniSenderResponse | null = null;

  try {
    data = JSON.parse(rawText) as UniSenderResponse;
  } catch {
    console.error(`[EMAIL] ${emailType} error`, {
      httpStatus: response.status,
      reason: "INVALID_JSON_RESPONSE",
      responsePreview: rawText.slice(0, 300),
    });

    throw new Error("UniSender returned invalid JSON");
  }

  if (!response.ok) {
    console.error(`[EMAIL] ${emailType} error`, {
      httpStatus: response.status,
      code: data.code,
      error: data.error,
    });

    throw new Error(
      `UniSender HTTP ${response.status}: ${data.error || "unknown error"}`
    );
  }

  if (data.error) {
    console.error(`[EMAIL] ${emailType} error`, {
      httpStatus: response.status,
      code: data.code,
      error: data.error,
    });

    throw new Error(`UniSender error: ${data.error}`);
  }

  const recipientResult = data.result?.[0];

  if (!recipientResult) {
    console.error(`[EMAIL] ${emailType} error`, {
      httpStatus: response.status,
      reason: "EMPTY_RESULT",
    });

    throw new Error("UniSender returned empty result");
  }

  if (recipientResult.errors?.length) {
    const errorMessage = recipientResult.errors
      .map((item) => item.message || item.code || "Unknown error")
      .join("; ");

    console.error(`[EMAIL] ${emailType} error`, {
      httpStatus: response.status,
      errors: recipientResult.errors,
    });

    throw new Error(`UniSender rejected email: ${errorMessage}`);
  }

  if (!recipientResult.id) {
    console.error(`[EMAIL] ${emailType} error`, {
      httpStatus: response.status,
      reason: "EMAIL_ID_MISSING",
      result: recipientResult,
    });

    throw new Error("UniSender did not return email id");
  }

  console.info(`[EMAIL] ${emailType} success`, {
    emailId: recipientResult.id,
  });

  return recipientResult.id;
}

export async function sendVerificationEmail(params: {
  to: string;
  verificationUrl: string;
}): Promise<string> {
  const verificationUrl = escapeHtml(params.verificationUrl);

  return sendEmail({
    to: params.to,
    emailType: "verification",
    subject: "Подтвердите регистрацию на платформе",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #17213c;">
        <h2>Подтверждение регистрации</h2>

        <p>Добрый день!</p>

        <p>
          Вы зарегистрировались на платформе судебных экспертов.
          Чтобы завершить регистрацию и войти в личный кабинет,
          подтвердите адрес электронной почты.
        </p>

        <p style="margin: 28px 0;">
          <a
            href="${verificationUrl}"
            style="
              display: inline-block;
              padding: 12px 22px;
              border-radius: 6px;
              background: #0b3b75;
              color: #ffffff;
              text-decoration: none;
              font-weight: 700;
            "
          >
            Подтвердить почту
          </a>
        </p>

        <p style="font-size: 13px; color: #667085;">
          Ссылка действует 24 часа.
        </p>

        <p style="font-size: 13px; color: #667085;">
          Если вы не регистрировались на платформе,
          просто проигнорируйте это письмо.
        </p>

        <p>
          С уважением,<br />
          Платформа судебных экспертов
        </p>
      </div>
    `,
  });
}

export async function sendPasswordResetEmail(params: {
  to: string;
  resetUrl: string;
}): Promise<string> {
  const resetUrl = escapeHtml(params.resetUrl);

  return sendEmail({
    to: params.to,
    emailType: "password_reset",
    subject: "Восстановление пароля",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #17213c;">
        <h2>Восстановление пароля</h2>

        <p>Добрый день!</p>

        <p>
          Мы получили запрос на восстановление пароля.
          Чтобы задать новый пароль, нажмите кнопку ниже.
        </p>

        <p style="margin: 28px 0;">
          <a
            href="${resetUrl}"
            style="
              display: inline-block;
              padding: 12px 22px;
              border-radius: 6px;
              background: #0b3b75;
              color: #ffffff;
              text-decoration: none;
              font-weight: 700;
            "
          >
            Восстановить пароль
          </a>
        </p>

        <p style="font-size: 13px; color: #667085;">
          Если вы не запрашивали восстановление пароля,
          проигнорируйте это письмо.
        </p>

        <p>
          С уважением,<br />
          Платформа судебных экспертов
        </p>
      </div>
    `,
  });
}
