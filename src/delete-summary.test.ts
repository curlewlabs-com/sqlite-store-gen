import { expect, test } from "bun:test";
import type { LocalSQLiteRawSpec, LocalSQLiteTableSpec } from "./model";
import { renderLocalSQLiteSources } from "./render";
import { normalizeLocalSQLiteSpec } from "./spec";
import { cloneSpec, loadExampleRaw } from "./test-support";

// A counted owner cleanup on a second table whose owner column has another name. The
// owner is whatever column the operation's single predicate binds; this guards the regression
// where the summary statement or the emitted parameter falls back to a fixed column name,
// which would compile against a column the table does not have.
function tenantQueue(): LocalSQLiteTableSpec {
  return {
    name: "tenant_queue_probe",
    doc: "Synthetic fixture for a counted cleanup keyed on a differently named owner.",
    primaryKey: ["staged_at_ms"],
    uniqueKeys: [],
    indexes: [
      {
        name: "idx_tenant_queue_probe_tenant_observed",
        columns: ["tenant_key", "observed_at_ms"],
      },
    ],
    analyze: true,
    keyedBy: "staged_at_ms",
    columns: [
      {
        name: "staged_at_ms",
        sqliteType: "INTEGER",
        nullable: false,
        brand: "TenantQueueProbeStagedAtMs",
      },
      {
        name: "tenant_key",
        sqliteType: "TEXT",
        nullable: false,
        brand: "TenantQueueProbeTenantKey",
      },
      {
        name: "observed_at_ms",
        sqliteType: "INTEGER",
        nullable: false,
        brand: "TenantQueueProbeObservedAtMs",
      },
      {
        name: "row_version",
        sqliteType: "INTEGER",
        nullable: false,
        brand: "StoredTenantQueueProbeRowVersion",
        check: "row_version >= 1",
      },
    ],
    operations: [
      {
        name: "delete_for_tenant_queue_probe",
        kind: "delete",
        predicate: [
          {
            column: "tenant_key",
            operator: "=",
            brand: "TenantQueueProbeTenantKey",
          },
        ],
        deleteSummary: { observedAtColumn: "observed_at_ms" },
      },
    ],
  };
}

// The fixture joins the example spec as a table a later version adds an index to, which is
// the shape a shipped table's new index takes: a ladder step creates it.
function withTenantQueue(
  table: LocalSQLiteTableSpec,
): Promise<LocalSQLiteRawSpec> {
  return loadExampleRaw().then((example) => {
    const raw = cloneSpec(example);
    raw.tables.push(table);
    raw.schemaVersion += 1;
    raw.migrations.push({
      toVersion: raw.schemaVersion,
      doc: "Synthetic: index the tenant queue probe for counted cleanup.",
      statements: [
        "CREATE INDEX idx_tenant_queue_probe_tenant_observed ON tenant_queue_probe (tenant_key, observed_at_ms)",
      ],
    });
    return raw;
  });
}

const OPTIONS = {
  kotlinPackage: "org.example.storage",
  bindingPackage: "org.example.sqlite",
  databaseFileName: "example.sqlite3",
  notice: "// test",
};

test("a counted cleanup keys its summary and parameter on its predicate's owner column", async () => {
  const raw = await withTenantQueue(tenantQueue());

  const sources = renderLocalSQLiteSources(
    normalizeLocalSQLiteSpec(raw),
    OPTIONS,
  );

  // Swift wraps the statement before FROM; the text is the same SQL.
  expect(sources.kotlin).toContain(
    "SELECT COUNT(*), MIN(observed_at_ms) FROM tenant_queue_probe WHERE tenant_key = ?",
  );
  expect(sources.swift).toContain(
    "FROM tenant_queue_probe WHERE tenant_key = ?",
  );
  expect(sources.kotlin).toContain(
    "(tenantKey: TenantQueueProbeTenantKey): LocalSQLiteDeleteResult",
  );
  expect(sources.swift).toContain("tenantKey: TenantQueueProbeTenantKey");
  expect(sources.swift).toContain("Summary(tenantKey: tenantKey)");
});

// The owner shape is what makes the count an exact-owner count: once the owner is read
// off the predicate, a non-TEXT predicate column would otherwise pass as one. (A nullable
// one never gets this far - a predicate on a nullable column is refused for every kind.)
test("rejects a counted cleanup whose predicate column is not TEXT", async () => {
  const table = tenantQueue();
  table.columns.find((column) => column.name === "tenant_key")!.sqliteType =
    "INTEGER";
  const raw = await withTenantQueue(table);

  expect(() => normalizeLocalSQLiteSpec(raw)).toThrow("deleteSummary requires");
});
