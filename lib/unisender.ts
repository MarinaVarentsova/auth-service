type SendEmailParams = {
  to: string;
  subject: string;
  html: string;
};

type UniSenderResultItem = {
  id?: string;
  errors?: Array<{
    code?: string;
    message?: string;
  }>;
};

type UniSenderResponse = {
  result?: UniSenderResultItem[];
  error?: string;
  code?: string;
};

export async function sendEmail({
  to,
  subject,
  html,
}: SendEmailParams): Promise<void> {
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
    email: to,
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

  const data = (await response.json().catch(() => null)) as
    | UniSenderResponse
    | null;

  if (!response.ok) {
    throw new Error(`UniSender HTTP error: ${response.status}`);
  }

  if (!data) {
    throw new Error("UniSender returned an empty response");
  }

  if (data.error) {
    throw new Error(`UniSender error: ${data.error}`);
  }

  const recipientResult = data.result?.[0];

  if (recipientResult?.errors?.length) {
    const message = recipientResult.errors
      .map((item) => item.message || item.code || "Unknown error")
      .join("; ");

    throw new Error(`UniSender rejected email: ${message}`);
  }

  if (!recipientResult?.id) {
    throw new Error("UniSender did not return email id");
  }
}

export async function sendVerificationEmail(params: {
  to: string;
  verificationUrl: string;
}): Promise<void> {
  const { to, verificationUrl } = params;

  await sendEmail({
    to,
    subject: "Подтверждение регистрации",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #17213c;">
        <h2>Подтвердите регистрацию</h2>

        <p>
          Вы зарегистрировались на платформе судебных экспертов.
          Для активации аккаунта подтвердите адрес электронной почты.
        </p>

        <p style="margin: 28px 0;">
          <a
            href="${verificationUrl}"
            style="
              display: inline-block;
              padding: 12px 22px;
              border-radius: 6px;
              background: #97257f;
              color: #ffffff;
              text-decoration: none;
              font-weight: 700;
            "
          >
            Подтвердить email
          </a>
        </p>

        <p style="font-size: 13px; color: #667085;">
          Ссылка действует 24 часа.
        </p>

        <p style="font-size: 13px; color: #667085;">
          Если вы не регистрировались на платформе, просто проигнорируйте это письмо.
        </p>
      </div>
    `,
  });
}
