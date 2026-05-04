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

function statementsArray(graph) {
  if (Array.isArray(graph?.statements)) return graph.statements;
  return Object.values(graph?.statements || {});
}

function enumStatements(graph) {
  return statementsArray(graph).filter((statement) => statement.kind === "enum");
}

function enumForType(graph, fieldType) {
  const normalized = String(fieldType || "").replace(/^enum_/, "");
  return enumStatements(graph).find((statement) => (
    statement.id === fieldType ||
    statement.id === `enum_${normalized}` ||
    statement.id === normalized
  )) || null;
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
  if (column.enumValues) return `"${pascal(column.fieldType)}"`;
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

function relationTargetTable(tables, relation) {
  const targetId = relation?.target?.id;
  return tables.find((table) => table.entity?.id === targetId)?.table || slug(String(targetId || "").replace(/^entity_/, ""));
}

function literal(value, type) {
  if (type === "boolean") return String(value) === "true" ? "true" : "false";
  if (type === "integer" || type === "number") return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

function renderSql(tables) {
  const blocks = [];
  const emittedEnums = new Set();
  for (const table of tables) {
    for (const column of table.columns || []) {
      if (!column.enumValues || emittedEnums.has(column.fieldType)) continue;
      emittedEnums.add(column.fieldType);
      blocks.push(`DO $$ BEGIN\n  CREATE TYPE "${pascal(column.fieldType)}" AS ENUM (${column.enumValues.map((value) => literal(value, "string")).join(", ")});\nEXCEPTION\n  WHEN duplicate_object THEN null;\nEND $$;`);
    }
  }
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
      if (fields.length > 0 && index.type !== "unique") {
        blocks.push(`CREATE INDEX IF NOT EXISTS "${table.table}_${fields.join("_")}_idx" ON "${table.table}" (${fields.map((field) => `"${field}"`).join(", ")});`);
      }
    }
    for (const relation of table.relations || []) {
      const targetTable = relationTargetTable(tables, relation);
      const onDelete = relation.onDelete ? ` ON DELETE ${String(relation.onDelete).replace(/_/g, " ").toUpperCase()}` : "";
      blocks.push(`ALTER TABLE "${table.table}" ADD FOREIGN KEY ("${relation.field}") REFERENCES "${targetTable}"("${relation.target.field}")${onDelete};`);
    }
  }
  return `${blocks.join("\n\n")}\n`;
}

function prismaType(column) {
  if (column.enumValues) return pascal(column.fieldType);
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
  if (column.enumValues) return "";
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
  const emittedEnums = new Set();
  for (const table of tables) {
    for (const column of table.columns || []) {
      if (!column.enumValues || emittedEnums.has(column.fieldType)) continue;
      emittedEnums.add(column.fieldType);
      lines.push(`enum ${pascal(column.fieldType)} {`);
      for (const value of column.enumValues) lines.push(`  ${value}`);
      lines.push("}");
      lines.push("");
    }
  }
  const relationBackrefs = new Map();
  for (const table of tables) {
    for (const relation of table.relations || []) {
      const targetTable = relationTargetTable(tables, relation);
      if (!relationBackrefs.has(targetTable)) relationBackrefs.set(targetTable, []);
      relationBackrefs.get(targetTable).push({
        fromTable: table.table,
        fromModel: pascal(table.entity?.id || table.table),
        field: relation.field,
        relationName: `${pascal(table.entity?.id || table.table)}_${relation.field}_to_${pascal(relation.target?.id || targetTable)}`
      });
    }
  }
  for (const table of tables) {
    const model = pascal(table.entity?.id || table.table);
    const relationFields = new Map((table.relations || []).map((relation) => [relation.field, relation]));
    lines.push(`model ${model} {`);
    for (const column of table.columns || []) {
      const attrs = [];
      if ((table.primaryKey || []).length === 1 && table.primaryKey[0] === column.name) attrs.push("@id");
      if ((table.uniques || []).some((fields) => fields.length === 1 && fields[0] === column.name)) attrs.push("@unique");
      if (column.defaultValue != null) {
        attrs.push(column.enumValues || column.fieldType === "boolean" || column.fieldType === "integer" || column.fieldType === "number"
          ? `@default(${String(column.defaultValue)})`
          : `@default(${JSON.stringify(String(column.defaultValue))})`);
      }
      lines.push(`  ${column.sourceField || column.name} ${prismaType(column)}${isRequired(column) ? "" : "?"}${prismaDbAttr(column)}${attrs.length ? ` ${attrs.join(" ")}` : ""}`);
      const relation = relationFields.get(column.name);
      if (relation) {
        const targetModel = pascal(relation.target?.id || relationTargetTable(tables, relation));
        const relationName = `${model}_${column.sourceField || column.name}_to_${targetModel}`;
        const optional = isRequired(column) ? "" : "?";
        const fieldName = String(column.sourceField || column.name).replace(/_id$/, "");
        lines.push(`  ${fieldName} ${targetModel}${optional} @relation("${relationName}", fields: [${column.sourceField || column.name}], references: [${relation.target.field}])`);
      }
    }
    for (const backref of relationBackrefs.get(table.table) || []) {
      lines.push(`  ${backref.fromTable} ${backref.fromModel}[] @relation("${backref.relationName}")`);
    }
    for (const index of table.indexes || []) {
      if (index.type === "index") lines.push(`  @@index([${index.fields.join(", ")}])`);
    }
    if (table.table !== slug(model)) lines.push(`  @@map("${table.table}")`);
    lines.push("}");
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function drizzleColumn(column) {
  if (column.enumValues) {
    return `${slug(column.fieldType)}Enum("${column.name}")${isRequired(column) ? ".notNull()" : ""}${column.defaultValue != null ? `.default(${literal(column.defaultValue, "string")})` : ""}`;
  }
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
  const lines = ['import { boolean, doublePrecision, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";', ""];
  const emittedEnums = new Set();
  for (const table of tables) {
    for (const column of table.columns || []) {
      if (!column.enumValues || emittedEnums.has(column.fieldType)) continue;
      emittedEnums.add(column.fieldType);
      lines.push(`export const ${slug(column.fieldType)}Enum = pgEnum("${slug(column.fieldType)}", [${column.enumValues.map((value) => `"${value}"`).join(", ")}]);`);
    }
  }
  if (emittedEnums.size > 0) lines.push("");
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

function shellScript(body) {
  return `#!/usr/bin/env bash\nset -euo pipefail\n\n${body.trim()}\n`;
}

function renderDbCommonScript() {
  return shellScript(`
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
DB_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STATE_DIR="$DB_DIR/state"
mkdir -p "$STATE_DIR"
`);
}

function renderDbBootstrapScript() {
  return shellScript(`
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/db-common.sh"
echo "Postgres lifecycle bundle is ready at $DB_DIR."
echo "Runtime schema application is handled by the API Prisma service during app bootstrap."
`);
}

function renderDbMigrateScript() {
  return shellScript(`
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/db-common.sh"
echo "No pending generated Postgres lifecycle migration was applied."
echo "Use schema.sql or migrations/0001_init.sql with your migration runner, or let the generated API Prisma bootstrap push the runtime schema."
`);
}

function renderDbStatusScript() {
  return shellScript(`
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/db-common.sh"
echo "Postgres lifecycle files:"
for file in schema.sql migrations/0001_init.sql prisma/schema.prisma lifecycle.plan.json state/desired.snapshot.json; do
  if [[ -f "$DB_DIR/$file" ]]; then
    echo "- $file"
  else
    echo "- missing: $file"
  fi
done
`);
}

function generate(context) {
  const tables = tablesFor(context || {}).map((table) => ({
    ...table,
    columns: (table.columns || []).map((column) => {
      const enumStatement = enumForType(context?.graph || {}, column.fieldType);
      return enumStatement ? { ...column, enumValues: enumStatement.values || [] } : column;
    })
  }));
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
    "scripts/db-common.sh": renderDbCommonScript(),
    "scripts/db-bootstrap.sh": renderDbBootstrapScript(),
    "scripts/db-migrate.sh": renderDbMigrateScript(),
    "scripts/db-status.sh": renderDbStatusScript(),
    "scripts/db-bootstrap-or-migrate.sh": shellScript(`
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
bash "$SCRIPT_DIR/db-bootstrap.sh"
`),
    "snapshots/empty.snapshot.json": `${JSON.stringify({ engine: "postgres", tables: [] }, null, 2)}\n`,
    "state/.gitkeep": "",
    "README.md": `# ${context?.component?.id || "Postgres DB"}\n\nGenerated Postgres lifecycle bundle for projection \`${context?.projection?.id || "unknown"}\`.\n\nRun \`npm run check\` to verify generated lifecycle files.\n`
  };
  return {
    files,
    artifacts: { generator: manifest.id, projection: context?.projection?.id || null, tableCount: tables.length, lifecycle: true },
    diagnostics: []
  };
}

module.exports = { manifest, generate };
