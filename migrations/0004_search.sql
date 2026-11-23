-- Beta phase 2: user-facing search. ADDITIVE ONLY (new view, FTS5 table, triggers, partial index).
-- Nothing in the fetcher changes. Product upserts are already guarded (no-op rows don't UPDATE),
-- so these triggers fire only when a product is new or its name/category actually changes.

-- Derived search fields. "kind" (spirits/wine/beer/cider/premixed/other) is derived from the DABS
-- display group (category); when that is ambiguous (e.g. "ALLOCATED ITEM", "LIMITED OFFERS") we fall
-- back to strong keywords in the product name. Keep this the single source of truth for the mapping.
CREATE VIEW product_search_source AS
SELECT rid, sku, name, size_ml, price_cents, status, status_label, category, name_n, category_n,
  CASE
    WHEN c LIKE '% BEER %' OR c LIKE '% MALT %' OR c LIKE '% ALE %' OR c LIKE '% LAGER %' OR c LIKE '% SELTZER %' THEN 'beer'
    WHEN c LIKE '% CIDER %' OR c LIKE '% PERRY %' THEN 'cider'
    WHEN c LIKE '% PREMIX%' OR c LIKE '% COCKTAIL%' OR c LIKE '% RTD %' THEN 'premixed'
    WHEN c LIKE '% WHISK%' OR c LIKE '% BOURBON %' OR c LIKE '% SCOTCH %' OR c LIKE '% VODKA %' OR c LIKE '% GIN %'
      OR c LIKE '% RUM %' OR c LIKE '% TEQUILA %' OR c LIKE '% MEZCAL %' OR c LIKE '% BRANDY %' OR c LIKE '% COGNAC %'
      OR c LIKE '% ARMAGNAC %' OR c LIKE '% LIQUEUR%' OR c LIKE '% CORDIAL%' OR c LIKE '% SCHNAPPS %'
      OR c LIKE '% SPIRIT%' OR c LIKE '% ABSINTHE %' OR c LIKE '% AQUAVIT %' OR c LIKE '% MOONSHINE %' THEN 'spirits'
    WHEN c LIKE '% WINE%' OR c LIKE '% RED %' OR c LIKE '% WHITE %' OR c LIKE '% ROSE %' OR c LIKE '% BLUSH %'
      OR c LIKE '% SPARKLING %' OR c LIKE '% CHAMPAGNE %' OR c LIKE '% PORT %' OR c LIKE '% SHERRY %' OR c LIKE '% MADEIRA %'
      OR c LIKE '% VERMOUTH %' OR c LIKE '% MARSALA %' OR c LIKE '% SAKE %' THEN 'wine'
    -- category didn't decide it: strong name keywords only
    WHEN n LIKE '% BEER %' OR n LIKE '% IPA %' OR n LIKE '% LAGER %' OR n LIKE '% STOUT %' OR n LIKE '% PILSNER %' THEN 'beer'
    WHEN n LIKE '% CIDER %' THEN 'cider'
    WHEN n LIKE '% WHISK%' OR n LIKE '% BOURBON %' OR n LIKE '% SCOTCH %' OR n LIKE '% VODKA %' OR n LIKE '% GIN %'
      OR n LIKE '% RUM %' OR n LIKE '% TEQUILA %' OR n LIKE '% MEZCAL %' OR n LIKE '% BRANDY %' OR n LIKE '% COGNAC %'
      OR n LIKE '% LIQUEUR %' THEN 'spirits'
    WHEN n LIKE '% WINE %' OR n LIKE '% CHAMPAGNE %' OR n LIKE '% PROSECCO %' OR n LIKE '% CABERNET %'
      OR n LIKE '% CHARDONNAY %' OR n LIKE '% PINOT %' OR n LIKE '% MERLOT %' OR n LIKE '% SAUVIGNON %' THEN 'wine'
    ELSE 'other'
  END AS kind
FROM (
  SELECT rowid AS rid, sku, name, size_ml, price_cents, status, status_label, category,
    replace(name, '''', '') AS name_n,
    COALESCE(category, '') AS category_n,
    ' ' || upper(replace(replace(replace(replace(replace(COALESCE(category, ''), '-', ' '), '&', ' '), ',', ' '), '/', ' '), '''', '')) || ' ' AS c,
    ' ' || upper(replace(replace(replace(replace(replace(name, '-', ' '), '&', ' '), ',', ' '), '/', ' '), '''', '')) || ' ' AS n
  FROM products
);

-- Full-text index. rowid = products.rowid (stable across ON CONFLICT DO UPDATE). detail=column keeps the
-- index small (no phrase/NEAR queries needed); column filters and prefix queries still work.
CREATE VIRTUAL TABLE product_search USING fts5(
  name, category, kind,
  tokenize = 'unicode61 remove_diacritics 2',
  detail = column
);

INSERT INTO product_search (rowid, name, category, kind)
  SELECT rid, name_n, category_n, kind FROM product_search_source;

CREATE TRIGGER products_search_ai AFTER INSERT ON products BEGIN
  INSERT INTO product_search (rowid, name, category, kind)
    SELECT rid, name_n, category_n, kind FROM product_search_source WHERE rid = new.rowid;
END;

CREATE TRIGGER products_search_au AFTER UPDATE OF name, category ON products
  WHEN old.name IS NOT new.name OR old.category IS NOT new.category BEGIN
  DELETE FROM product_search WHERE rowid = old.rowid;
  INSERT INTO product_search (rowid, name, category, kind)
    SELECT rid, name_n, category_n, kind FROM product_search_source WHERE rid = new.rowid;
END;

CREATE TRIGGER products_search_ad AFTER DELETE ON products BEGIN
  DELETE FROM product_search WHERE rowid = old.rowid;
END;

-- "What's at this store": per-store rows only (store_key '' = product-level rows are excluded, so the
-- fetcher's nightly product-level writes don't touch this index). Queries must include store_key <> ''.
CREATE INDEX idx_latest_store ON inventory_latest (store_key, sku) WHERE store_key <> '';
