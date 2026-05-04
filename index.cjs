const manifest = require("./topogram-generator.json");

function slug(value, fallback = "resource") {
  return String(value || fallback).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || fallback;
}

function pascal(value, fallback = "Resource") {
  const base = String(value || fallback).replace(/^entity_/, "");
  const result = base.split(/[^A-Za-z0-9]+/).filter(Boolean).map((part) => `${part[0].toUpperCase()}${part.slice(1)}`).join("");
  return result || fallback;
}

function entitiesFromGraph(graph) {
  return Object.values(graph.statements || {}).filter((statement) => statement.kind === "entity");
}

function tableName(entity) {
  return slug(entity.table || entity.name || entity.id, "resource");
}

function normalizeGraphEntity(entity) {
  const fields = Array.isArray(entity.fields) && entity.fields.length > 0
    ? entity.fields
    : [{ name: "id", type: "uuid", required: true }, { name: "name", type: "text", required: true }];
  const primaryKey = Array.isArray(entity.primaryKey) ? entity.primaryKey : entity.keys?.primary || (fields.some((field) => field.name === "id") ? ["id"] : []);
  const indexes = [
    ...(Array.isArray(entity.indexes) ? entity.indexes : []),
    ...((entity.keys?.index || []).map((fields) => ({ type: "index", fields: Array.isArray(fields) ? fields : [fields] })))
  ];
  return {
    table: tableName(entity),
    entity: { id: entity.id || tableName(entity) },
    columns: fields.map((field) => ({
      name: slug(field.column || field.name, "field"),
      sourceField: field.name || slug(field.column, "field"),
      fieldType: field.type || field.scalar || "text",
      required: field.required !== false && field.requiredness !== "optional",
      defaultValue: field.defaultValue ?? field.default ?? null
    })),
    primaryKey,
    uniques: Array.isArray(entity.uniques) ? entity.uniques : [],
    indexes,
    relations: [],
    lifecycle: {}
  };
}

function tablesFor(context) {
  const dbContract = context.contracts && context.contracts.db;
  if (dbContract && Array.isArray(dbContract.tables)) {
    return dbContract.tables;
  }
  if (dbContract && context.projection?.id && dbContract[context.projection.id]?.tables) {
    return dbContract[context.projection.id].tables;
  }
  const entities = entitiesFromGraph(context.graph || {});
  return (entities.length > 0 ? entities : [{ id: "entity_resource", name: "Resource" }]).map(normalizeGraphEntity);
}

function sqlType(column) {
  switch (String(column.fieldType || "text")) {
    case "uuid":
      return "UUID";
    case "datetime":
      return "TIMESTAMPTZ";
    case "integer":
      return "INTEGER";
    case "number":
      return "DOUBLE PRECISION";
    case "boolean":
      return "BOOLEAN";
    default:
      return "TEXT";
  }
}

function columnSql(column) {
  const parts = [`"${column.name}"`, sqlType(column)];
  if (isRequired(column)) parts.push("NOT NULL");
  if (column.defaultValue != null) {
    parts.push("DEFAULT", literal(column.defaultValue, column.fieldType));
  }
  return parts.join(" ");
}

function literal(value, type) {
  if (type === "boolean") return String(value) === "true" ? "true" : "false";
  if (type === "integer" || type === "number") return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

function renderSql(tables) {
  const blocks = [];
  for (const table of tables) {
    const columns = table.columns || [];
    const lines = columns.map((column) => `  ${columnSql(column)}`);
    if ((table.primaryKey || []).length > 0) {
      lines.push(`  PRIMARY KEY (${table.primaryKey.map((field) => `"${field}"`).join(", ")})`);
    }
    blocks.push(`CREATE TABLE IF NOT EXISTS "${table.table}" (\n${lines.join(",\n")}\n);`);
    for (const fields of table.uniques || []) {
      blocks.push(`CREATE UNIQUE INDEX IF NOT EXISTS "${table.table}_${fields.join("_")}_unique" ON "${table.table}" (${fields.map((field) => `"${field}"`).join(", ")});`);
    }
    for (const index of table.indexes || []) {
      const fields = Array.isArray(index.fields) ? index.fields : [];
      if (fields.length > 0) {
        blocks.push(`CREATE INDEX IF NOT EXISTS "${table.table}_${fields.join("_")}_idx" ON "${table.table}" (${fields.map((field) => `"${field}"`).join(", ")});`);
      }
    }
  }
  return `${blocks.join("\n\n")}\n`;
}

function prismaType(column) {
  switch (String(column.fieldType || "text")) {
    case "integer":
      return "Int";
    case "number":
      return "Float";
    case "boolean":
      return "Boolean";
    case "datetime":
      return "DateTime";
    default:
      return "String";
  }
}

function prismaDbAttr(column) {
  if (column.fieldType === "uuid") return " @db.Uuid";
  if (column.fieldType === "datetime") return " @db.Timestamptz(3)";
  return "";
}

function renderPrisma(tables) {
  const lines = [
    "generator client {",
    '  provider = "prisma-client-js"',
    "}",
    "",
    "datasource db {",
    '  provider = "postgresql"',
    '  url      = env("DATABASE_URL")',
    "}",
    ""
  ];
  for (const table of tables) {
    const model = pascal(table.entity?.id || table.table);
    lines.push(`model ${model} {`);
    for (const column of table.columns || []) {
      const attrs = [];
      if ((table.primaryKey || []).length === 1 && table.primaryKey[0] === column.name) attrs.push("@id");
      if ((table.uniques || []).some((fields) => fields.length === 1 && fields[0] === column.name)) attrs.push("@unique");
      if (column.defaultValue != null) attrs.push(`@default(${JSON.stringify(String(column.defaultValue))})`);
      lines.push(`  ${column.sourceField || column.name} ${prismaType(column)}${isRequired(column) ? "" : "?"}${prismaDbAttr(column)}${attrs.length ? ` ${attrs.join(" ")}` : ""}`);
    }
    if (table.table !== slug(model)) lines.push(`  @@map("${table.table}")`);
    lines.push("}");
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function drizzleColumn(column) {
  const fn = column.fieldType === "uuid" ? "uuid" : column.fieldType === "integer" ? "integer" : column.fieldType === "number" ? "doublePrecision" : column.fieldType === "boolean" ? "boolean" : column.fieldType === "datetime" ? "timestamp" : "text";
  const args = fn === "timestamp" ? `"${column.name}", { withTimezone: true, mode: "string" }` : `"${column.name}"`;
  const chain = [];
  if (isRequired(column)) chain.push("notNull()");
  if (column.defaultValue != null) chain.push(`default(${literal(column.defaultValue, column.fieldType)})`);
  return `${fn}(${args})${chain.length ? `.${chain.join(".")}` : ""}`;
}

function isRequired(column) {
  return column.required === true || column.requiredness === "required";
}

function renderDrizzle(tables) {
  const lines = ['import { boolean, doublePrecision, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";', ""];
  for (const table of tables) {
    const tableVar = `${slug(table.table)}Table`;
    lines.push(`export const ${tableVar} = pgTable("${table.table}", {`);
    for (const column of table.columns || []) {
      const primary = (table.primaryKey || []).length === 1 && table.primaryKey[0] === column.name ? ".primaryKey()" : "";
      lines.push(`  ${column.sourceField || column.name}: ${drizzleColumn(column)}${primary},`);
    }
    lines.push("}, (table) => ({");
    for (const indexEntry of table.indexes || []) {
      const fields = Array.isArray(indexEntry.fields) ? indexEntry.fields : [];
      if (fields.length > 0) lines.push(`  ${table.table}_${fields.join("_")}_idx: index("${table.table}_${fields.join("_")}_idx").on(${fields.map((field) => `table.${field}`).join(", ")}),`);
    }
    for (const fields of table.uniques || []) {
      lines.push(`  ${table.table}_${fields.join("_")}_unique: uniqueIndex("${table.table}_${fields.join("_")}_unique").on(${fields.map((field) => `table.${field}`).join(", ")}),`);
    }
    lines.push("}));");
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function renderLifecyclePlan(context, tables) {
  return `${JSON.stringify(context.contracts?.lifecyclePlan || {
    type: "db_lifecycle_plan",
    projection: { id: context.projection?.id || null, platform: context.projection?.platform || "db_postgres" },
    engine: "postgres",
    tables: tables.map((table) => table.table),
    state: {
      currentSnapshot: "state/current.snapshot.json",
      desiredSnapshot: "state/desired.snapshot.json",
      migrationSql: "state/migration.sql"
    }
  }, null, 2)}\n`;
}

function renderPackageJson() {
  return `${JSON.stringify({
    private: true,
    type: "module",
    scripts: {
      check: "node ./scripts/check.mjs",
      migrate: "node ./scripts/migrate.mjs",
      "migrate:plan": "node ./scripts/migration-plan.mjs"
    },
    devDependencies: {
      "@prisma/client": "^6.0.0",
      "drizzle-orm": "^0.36.4",
      prisma: "^6.0.0"
    }
  }, null, 2)}\n`;
}

function generate(context) {
  const tables = tablesFor(context || {});
  const sql = renderSql(tables);
  const files = {
    "schema.sql": sql,
    "migrations/0001_init.sql": sql,
    "state/desired.snapshot.json": `${JSON.stringify({ engine: "postgres", tables }, null, 2)}\n`,
    "lifecycle.plan.json": renderLifecyclePlan(context || {}, tables),
    "prisma/schema.prisma": renderPrisma(tables),
    "drizzle/schema.ts": renderDrizzle(tables),
    "package.json": renderPackageJson(),
    ".env.example": `DATABASE_URL=postgresql://postgres@localhost:5432/${slug(context?.projection?.id || "topogram")}\n`,
    "scripts/check.mjs": "import fs from 'node:fs'; for (const file of ['schema.sql', 'migrations/0001_init.sql', 'prisma/schema.prisma', 'drizzle/schema.ts', 'lifecycle.plan.json']) { if (!fs.existsSync(file)) throw new Error(`missing ${file}`); } console.log('Checked Postgres database lifecycle bundle.');\n",
    "scripts/migration-plan.mjs": "import fs from 'node:fs'; console.log(fs.readFileSync('lifecycle.plan.json', 'utf8'));\n",
    "scripts/migrate.mjs": "console.log('Apply migrations/0001_init.sql with your Postgres migration runner.');\n",
    "README.md": `# ${context?.component?.id || "Postgres DB"}\n\nGenerated Postgres lifecycle bundle for projection \`${context?.projection?.id || "unknown"}\`.\n\nRun \`npm run check\` to verify generated lifecycle files.\n`
  };
  return {
    files,
    artifacts: { generator: manifest.id, projection: context?.projection?.id || null, tableCount: tables.length, lifecycle: true },
    diagnostics: []
  };
}

module.exports = { manifest, generate };
