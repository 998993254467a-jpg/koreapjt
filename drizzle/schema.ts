import { boolean, decimal, index, int, mysqlEnum, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 * Extend this file with additional tables as your product grows.
 * Columns use camelCase to match both database fields and generated types.
 */
export const users = mysqlTable("users", {
  /**
   * Surrogate primary key. Auto-incremented numeric value managed by the database.
   * Use this for relations between tables.
   */
  id: int("id").autoincrement().primaryKey(),
  /** Manus OAuth identifier (openId) returned from the OAuth callback. Unique per user. */
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/**
 * Binance API credentials per user. Keys are encrypted at rest using AES-256-GCM.
 * Each user can register multiple credentials but only one is active at a time
 * (enforced at the application layer).
 */
export const binanceCredentials = mysqlTable(
  "binance_credentials",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull(),
    label: varchar("label", { length: 128 }).notNull().default("Default"),
    /** Encrypted Binance API key, base64 encoded with iv:tag:ciphertext layout. */
    encryptedApiKey: text("encryptedApiKey").notNull(),
    /** Encrypted Binance API secret, same format as the api key. */
    encryptedApiSecret: text("encryptedApiSecret").notNull(),
    /** Last 4 plaintext characters of the api key, used purely for UI display. */
    apiKeyLast4: varchar("apiKeyLast4", { length: 4 }).notNull(),
    isActive: boolean("isActive").notNull().default(true),
    isTestnet: boolean("isTestnet").notNull().default(false),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => ({
    userIdx: index("binance_credentials_user_idx").on(table.userId),
  }),
);

export type BinanceCredential = typeof binanceCredentials.$inferSelect;
export type InsertBinanceCredential = typeof binanceCredentials.$inferInsert;

/**
 * Local cache of trade orders submitted through this app. The Binance API
 * remains the source of truth, but a local copy enables fast history listing
 * and PnL calculation without burning API rate limits.
 */
export const tradeOrders = mysqlTable(
  "trade_orders",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull(),
    binanceOrderId: varchar("binanceOrderId", { length: 64 }),
    clientOrderId: varchar("clientOrderId", { length: 64 }),
    symbol: varchar("symbol", { length: 32 }).notNull(),
    side: mysqlEnum("side", ["BUY", "SELL"]).notNull(),
    type: mysqlEnum("type", ["MARKET", "LIMIT"]).notNull(),
    quantity: decimal("quantity", { precision: 24, scale: 12 }).notNull(),
    price: decimal("price", { precision: 24, scale: 12 }),
    executedQty: decimal("executedQty", { precision: 24, scale: 12 }).notNull().default("0"),
    cummulativeQuoteQty: decimal("cummulativeQuoteQty", { precision: 24, scale: 12 }).notNull().default("0"),
    status: varchar("status", { length: 32 }).notNull().default("NEW"),
    rawResponse: text("rawResponse"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => ({
    userSymbolIdx: index("trade_orders_user_symbol_idx").on(table.userId, table.symbol),
    createdIdx: index("trade_orders_created_idx").on(table.createdAt),
  }),
);

export type TradeOrder = typeof tradeOrders.$inferSelect;
export type InsertTradeOrder = typeof tradeOrders.$inferInsert;

/**
 * Automated bot trade history — records every closed position from the bot engine.
 * The bot engine keeps an in-memory copy; this table persists it across restarts.
 */
export const botTradeHistory = mysqlTable(
  "bot_trade_history",
  {
    id: varchar("id", { length: 64 }).primaryKey(), // nanoid from bot engine
    userId: int("userId").notNull(),
    date: varchar("date", { length: 32 }).notNull(),
    symbol: varchar("symbol", { length: 32 }).notNull(),
    side: mysqlEnum("side", ["Buy", "Sell"]).notNull(),
    direction: mysqlEnum("direction", ["LONG", "SHORT"]).notNull(),
    avgPrice: decimal("avgPrice", { precision: 24, scale: 8 }).notNull(),
    entryPrice: decimal("entryPrice", { precision: 24, scale: 8 }).notNull(),
    closePrice: decimal("closePrice", { precision: 24, scale: 8 }).notNull(),
    pnl: decimal("pnl", { precision: 24, scale: 8 }).notNull(),
    pnlNet: decimal("pnlNet", { precision: 24, scale: 8 }).notNull(),
    fee: decimal("fee", { precision: 24, scale: 8 }).notNull(),
    pnlPct: decimal("pnlPct", { precision: 12, scale: 6 }).notNull(),
    leverage: int("leverage").notNull(),
    closedAt: int("closedAt").notNull(), // Unix ms
    sourceType: varchar("sourceType", { length: 16 }), // 'top7' | 'surge' | 'presurge'
    holdingMinutes: int("holdingMinutes"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => ({
    userIdx: index("bot_trade_history_user_idx").on(table.userId),
    closedAtIdx: index("bot_trade_history_closed_idx").on(table.closedAt),
  }),
);

export type BotTradeRecord = typeof botTradeHistory.$inferSelect;
export type InsertBotTradeRecord = typeof botTradeHistory.$inferInsert;
