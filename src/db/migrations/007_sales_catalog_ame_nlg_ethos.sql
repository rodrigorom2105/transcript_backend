WITH wanted_companies(code, name) AS (
  VALUES
    ('AME', 'AME'),
    ('NLG', 'NLG'),
    ('ETHOS', 'ETHOS')
)
INSERT INTO sales_companies (code, name, active)
SELECT code, name, TRUE
FROM wanted_companies
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name,
    active = TRUE;

UPDATE sales_companies
SET active = FALSE
WHERE code NOT IN ('AME', 'NLG', 'ETHOS');

WITH wanted_products(company_code, product_code, product_name) AS (
  VALUES
    ('AME', 'IUL', 'IUL'),
    ('AME', 'EAG', 'EAG'),
    ('AME', 'WL', 'WL'),
    ('NLG', 'IUL', 'IUL'),
    ('NLG', 'EAG', 'EAG'),
    ('NLG', 'WL', 'WL'),
    ('ETHOS', 'IUL', 'IUL'),
    ('ETHOS', 'EAG', 'EAG'),
    ('ETHOS', 'WL', 'WL')
)
INSERT INTO sales_products (company_id, code, name, active)
SELECT c.id, w.product_code, w.product_name, TRUE
FROM wanted_products w
JOIN sales_companies c ON c.code = w.company_code
ON CONFLICT (company_id, code) DO UPDATE
SET name = EXCLUDED.name,
    active = TRUE;

WITH wanted_products(company_code, product_code) AS (
  VALUES
    ('AME', 'IUL'),
    ('AME', 'EAG'),
    ('AME', 'WL'),
    ('NLG', 'IUL'),
    ('NLG', 'EAG'),
    ('NLG', 'WL'),
    ('ETHOS', 'IUL'),
    ('ETHOS', 'EAG'),
    ('ETHOS', 'WL')
)
UPDATE sales_products p
SET active = FALSE
FROM sales_companies c
WHERE p.company_id = c.id
  AND NOT EXISTS (
    SELECT 1
    FROM wanted_products w
    WHERE w.company_code = c.code
      AND w.product_code = p.code
  );
