import { Trigger } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  compareDecimalStrings,
  dedupeKeyForRule,
  evaluate,
  extractTriggerFacts,
  type EvaluatedRule,
  type InventoryFacts,
  type OrderFacts,
  type PaymentFailedFacts,
} from "../../app/lib/rules/triggers";
import failedTransaction from "../fixtures/failed-transaction.json";
import inventoryLevel from "../fixtures/inventory-level.json";
import highValueOrder from "../fixtures/order-high-value-product.json";
import normalOrder from "../fixtures/order-normal.json";
import paidOrder from "../fixtures/order-paid.json";
import refund from "../fixtures/refund.json";

function rule(
  trigger: Trigger,
  conditions: Record<string, unknown> = {},
  id = `rule-${trigger.toLowerCase()}`,
): EvaluatedRule {
  return { id, trigger, enabled: true, conditions };
}

describe("pure rules evaluator", () => {
  it("evaluates ORDER_CREATED from the order fixture", () => {
    const facts = extractTriggerFacts("orders/create", normalOrder)!;
    expect(
      evaluate(Trigger.ORDER_CREATED, facts, [rule(Trigger.ORDER_CREATED)]),
    ).toHaveLength(1);
    expect(
      evaluate(Trigger.ORDER_PAID, facts, [rule(Trigger.ORDER_PAID)]),
    ).toHaveLength(0);
  });

  it("evaluates ORDER_PAID only from its topic", () => {
    const facts = extractTriggerFacts("ORDERS_PAID", paidOrder)!;
    expect(
      evaluate(Trigger.ORDER_PAID, facts, [rule(Trigger.ORDER_PAID)]),
    ).toHaveLength(1);
  });

  it("matches ORDER_VALUE_GTE at an exact decimal threshold across currency fixtures", () => {
    const facts = extractTriggerFacts("orders/create", highValueOrder)!;
    const valueRule = rule(Trigger.ORDER_VALUE_GTE, { minValue: "500.0" });
    expect(evaluate(Trigger.ORDER_VALUE_GTE, facts, [valueRule])).toEqual([
      valueRule,
    ]);
    expect(
      evaluate(Trigger.ORDER_VALUE_GTE, facts, [
        rule(Trigger.ORDER_VALUE_GTE, { minValue: "500.01" }),
      ]),
    ).toHaveLength(0);
    expect(
      compareDecimalStrings("9999999999999999.99", "9999999999999999.98"),
    ).toBe(1);
  });

  it("matches PRODUCT_ORDERED by product id or resolved collection id", () => {
    const extracted = extractTriggerFacts(
      "orders/create",
      highValueOrder,
    )! as OrderFacts;
    const facts: OrderFacts = {
      ...extracted,
      lineItemCollectionIds: ["collection-ops"],
    };
    const rules = [
      rule(Trigger.PRODUCT_ORDERED, { productIds: ["2002"] }, "product"),
      rule(
        Trigger.PRODUCT_ORDERED,
        { collectionIds: ["collection-ops"] },
        "collection",
      ),
      rule(Trigger.PRODUCT_ORDERED, { productIds: ["missing"] }, "missing"),
    ];
    expect(
      evaluate(Trigger.PRODUCT_ORDERED, facts, rules).map(({ id }) => id),
    ).toEqual(["product", "collection"]);
  });

  it("matches LOW_STOCK only on a downward threshold crossing", () => {
    const extracted = extractTriggerFacts(
      "inventory_levels/update",
      inventoryLevel,
    )!;
    const lowStockRule = rule(Trigger.LOW_STOCK, { stockThreshold: 5 });
    const crossing: InventoryFacts = {
      ...(extracted as InventoryFacts),
      previousAvailable: 6,
      epoch: 2,
    };
    expect(evaluate(Trigger.LOW_STOCK, crossing, [lowStockRule])).toHaveLength(
      1,
    );
    expect(
      evaluate(
        Trigger.LOW_STOCK,
        { ...crossing, previousAvailable: 5, available: 4 },
        [lowStockRule],
      ),
    ).toHaveLength(0);
    expect(dedupeKeyForRule(lowStockRule, crossing)).toBe(
      "rule-low_stock:low_stock:7001:8001:5:2",
    );
  });

  it("evaluates REFUND_CREATED and keys each refund resource", () => {
    const facts = extractTriggerFacts("refunds/create", refund)!;
    const refundRule = rule(Trigger.REFUND_CREATED);
    expect(evaluate(Trigger.REFUND_CREATED, facts, [refundRule])).toHaveLength(
      1,
    );
    expect(dedupeKeyForRule(refundRule, facts)).toBe(
      "rule-refund_created:refunds/create:9001",
    );
  });

  it("evaluates PAYMENT_FAILED only for failure transactions and keys the transaction", () => {
    const facts = extractTriggerFacts(
      "order_transactions/create",
      failedTransaction,
    )! as PaymentFailedFacts;
    const failedRule = rule(Trigger.PAYMENT_FAILED);
    expect(evaluate(Trigger.PAYMENT_FAILED, facts, [failedRule])).toHaveLength(
      1,
    );
    expect(dedupeKeyForRule(failedRule, facts)).toBe(
      "rule-payment_failed:order_transactions/create:6001",
    );
    expect(
      evaluate(
        Trigger.PAYMENT_FAILED,
        { ...facts, transactionStatus: "success" },
        [failedRule],
      ),
    ).toHaveLength(0);
  });

  it("does not match disabled rules, wrong triggers, invalid prices, or missing fields", () => {
    const facts = extractTriggerFacts("orders/create", normalOrder)!;
    expect(
      evaluate(Trigger.ORDER_CREATED, facts, [
        { ...rule(Trigger.ORDER_CREATED), enabled: false },
        rule(Trigger.ORDER_PAID),
      ]),
    ).toHaveLength(0);
    expect(
      evaluate(Trigger.ORDER_VALUE_GTE, facts, [
        rule(Trigger.ORDER_VALUE_GTE, { minValue: "not-a-price" }),
      ]),
    ).toHaveLength(0);
    expect(
      extractTriggerFacts("orders/create", { name: "#missing" }),
    ).toBeNull();
    expect(
      extractTriggerFacts("inventory_levels/update", { available: 1 }),
    ).toBeNull();
  });
});
