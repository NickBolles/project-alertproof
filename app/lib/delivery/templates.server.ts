import type { AlertMessage, ChannelType } from "../ports";

export type AlertTemplateContext = {
  deliveryId: string;
  messageKey: string;
  channelType: ChannelType;
  destination: string;
  shopDomain: string;
  ruleName?: string | null;
  orderId?: string | null;
  orderName?: string | null;
  orderValue?: string | null;
};

function text(context: AlertTemplateContext): string {
  const order = context.orderName ?? context.orderId ?? "an order";
  const value = context.orderValue ? ` (${context.orderValue})` : "";
  return `${context.ruleName ?? "AlertProof alert"}: ${order}${value}`;
}

export function renderAlertMessage(
  context: AlertTemplateContext,
): AlertMessage {
  const summary = text(context);
  const orderUrl = context.orderId
    ? `https://${context.shopDomain}/admin/orders/${encodeURIComponent(context.orderId.split("/").at(-1)!)}`
    : `https://${context.shopDomain}/admin/orders`;
  let payload: Record<string, unknown>;
  if (context.channelType === "email") {
    payload = {
      from: process.env.EMAIL_FROM ?? "alerts@alertproof.test",
      subject: `AlertProof: ${context.orderName ?? "order alert"}`,
      text: `${summary}\n${orderUrl}`,
      html: `<p>${summary}</p><p><a href="${orderUrl}">View order in Shopify</a></p>`,
      metadata: {
        deliveryId: context.deliveryId,
        messageKey: context.messageKey,
      },
    };
  } else if (context.channelType === "slack") {
    payload = {
      text: summary,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `*${summary}*` } },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "View order" },
              url: orderUrl,
            },
          ],
        },
      ],
    };
  } else if (context.channelType === "discord") {
    payload = {
      content: summary,
      embeds: [
        {
          title: context.orderName ?? "Order alert",
          description: summary,
          url: orderUrl,
        },
      ],
    };
  } else {
    payload = { body: `${summary} ${orderUrl}` };
  }
  return {
    deliveryId: context.deliveryId,
    messageKey: context.messageKey,
    channelType: context.channelType,
    destination: context.destination,
    payload,
  };
}

export function renderDigestMessage(input: {
  deliveryId: string;
  messageKey: string;
  destination: string;
  detail: unknown;
}): AlertMessage | null {
  if (
    !input.detail ||
    typeof input.detail !== "object" ||
    Array.isArray(input.detail)
  ) {
    return null;
  }
  const detail = input.detail as {
    kind?: unknown;
    subject?: unknown;
    text?: unknown;
    html?: unknown;
  };
  if (
    detail.kind !== "digest" ||
    typeof detail.subject !== "string" ||
    typeof detail.text !== "string" ||
    typeof detail.html !== "string"
  ) {
    return null;
  }
  return {
    deliveryId: input.deliveryId,
    messageKey: input.messageKey,
    channelType: "email",
    destination: input.destination,
    payload: {
      from: process.env.EMAIL_FROM ?? "alerts@alertproof.test",
      subject: detail.subject,
      text: detail.text,
      html: detail.html,
      metadata: {
        deliveryId: input.deliveryId,
        messageKey: input.messageKey,
      },
    },
  };
}
