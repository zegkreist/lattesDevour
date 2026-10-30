-- rede: quantos níveis da rede deste CV priorizar quando ele for processado (pedido pelo painel).
-- Zera depois de propagar, para "Reprocessar todos" não repriorizar redes antigas.
-- caminho: por onde o CV foi baixado ('cv' = link direto, captcha v2; 'previa' = prévia da busca, v3).
ALTER TABLE fila ADD COLUMN rede int NOT NULL DEFAULT 0, ADD COLUMN caminho text;
