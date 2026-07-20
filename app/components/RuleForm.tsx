import { Channel, Trigger } from "@prisma/client";
import { Form } from "react-router";
import { useState } from "react";

export type RuleFormRecipient = { id: string; name: string };
export type RuleFormValue = {
  id?: string;
  name: string;
  trigger: Trigger;
  enabled: boolean;
  conditions: Record<string, unknown>;
  routes: Array<{ recipientId: string; channels: Channel[] }>;
};

type PickerWindow = Window & {
  shopify?: {
    resourcePicker(input: {
      type: "product" | "collection";
      multiple: boolean;
    }): Promise<Array<{ id: string }> | undefined>;
  };
};

export function RuleForm({
  recipients,
  value,
  errors,
  allowedChannels = Object.values(Channel),
  authBypass = true,
}: {
  recipients: RuleFormRecipient[];
  value?: RuleFormValue;
  errors?: Record<string, string[]>;
  allowedChannels?: readonly Channel[];
  authBypass?: boolean;
}) {
  const selected = new Set(
    value?.routes.flatMap((route) =>
      route.channels.map((channel) => `${route.recipientId}:${channel}`),
    ) ?? [],
  );
  const initialProducts = Array.isArray(value?.conditions.productIds)
    ? value.conditions.productIds.join(",")
    : "";
  const initialCollections = Array.isArray(value?.conditions.collectionIds)
    ? value.conditions.collectionIds.join(",")
    : "";
  const [productIds, setProductIds] = useState(initialProducts);
  const [collectionIds, setCollectionIds] = useState(initialCollections);
  const pick = async (
    type: "product" | "collection",
    setValue: (value: string) => void,
  ) => {
    const selection = await (window as PickerWindow).shopify?.resourcePicker({
      type,
      multiple: true,
    });
    if (selection) setValue(selection.map((item) => item.id).join(","));
  };
  return (
    <Form method="post">
      {value?.id ? <input type="hidden" name="id" value={value.id} /> : null}
      {errors ? (
        <s-banner tone="critical">
          {Object.values(errors).flat().join(". ")}
        </s-banner>
      ) : null}
      <s-text-field
        name="name"
        label="Rule name"
        value={value?.name ?? ""}
        required
      />
      <label>
        Trigger
        <select
          name="trigger"
          defaultValue={value?.trigger ?? Trigger.ORDER_CREATED}
        >
          {Object.values(Trigger).map((trigger) => (
            <option key={trigger} value={trigger}>
              {trigger.replaceAll("_", " ")}
            </option>
          ))}
        </select>
      </label>
      <s-text-field
        name="minValue"
        label="Minimum order value (for value rules)"
        value={String(value?.conditions.minValue ?? "")}
      />
      <s-text-field
        name="stockThreshold"
        label="Stock threshold (for low stock)"
        value={String(value?.conditions.stockThreshold ?? "")}
      />
      {authBypass ? (
        <>
          <s-text-field
            name="productIds"
            label="Product IDs, comma separated"
            value={productIds}
          />
          <s-text-field
            name="collectionIds"
            label="Collection IDs, comma separated"
            value={collectionIds}
          />
        </>
      ) : (
        <>
          <input type="hidden" name="productIds" value={productIds} />
          <input type="hidden" name="collectionIds" value={collectionIds} />
          <s-button
            type="button"
            onClick={() => void pick("product", setProductIds)}
          >
            Choose products
          </s-button>
          <s-paragraph>{productIds || "No products selected"}</s-paragraph>
          <s-button
            type="button"
            onClick={() => void pick("collection", setCollectionIds)}
          >
            Choose collections
          </s-button>
          <s-paragraph>
            {collectionIds || "No collections selected"}
          </s-paragraph>
        </>
      )}
      <input
        type="hidden"
        name="enabled"
        value={value?.enabled === false ? "false" : "true"}
      />
      <fieldset>
        <legend>Recipients and channels</legend>
        {recipients.map((recipient) => (
          <div key={recipient.id}>
            <strong>{recipient.name}</strong>
            {Object.values(Channel).map((channel) => {
              const key = `${recipient.id}:${channel}`;
              const allowed = allowedChannels.includes(channel);
              return (
                <label key={key}>
                  <input
                    type="checkbox"
                    name="routes"
                    value={key}
                    defaultChecked={selected.has(key)}
                    disabled={!allowed}
                  />
                  {channel}
                  {allowed ? "" : " (upgrade required)"}
                </label>
              );
            })}
          </div>
        ))}
      </fieldset>
      <s-button type="submit" variant="primary">
        Save rule
      </s-button>
    </Form>
  );
}
