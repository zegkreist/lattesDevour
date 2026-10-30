-- Completa obra_fonte como "o que cada CV diz da obra": autores, tags, palavras-chave e áreas.
-- A obra passa a ser refeita a partir das fontes a cada (re)processamento (store/ingest.ts), então
-- reprocessar um CV troca só a contribuição dele. Fontes existentes herdam o estado atual da obra.
ALTER TABLE obra_fonte
  ADD COLUMN autores jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN tags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN palavras_chave text[] NOT NULL DEFAULT '{}',
  ADD COLUMN grandes_areas text[] NOT NULL DEFAULT '{}',
  ADD COLUMN areas text[] NOT NULL DEFAULT '{}';
UPDATE obra_fonte f SET
  tags = o.tags, palavras_chave = o.palavras_chave, grandes_areas = o.grandes_areas, areas = o.areas,
  autores = COALESCE((
    SELECT jsonb_agg(jsonb_build_object('ordem', a.ordem, 'nome', a.nome, 'nomeCitacao', a.nome_citacao, 'lattesId', a.autor_lattes_id) ORDER BY a.ordem)
    FROM autoria a WHERE a.obra_id = o.id), '[]')
FROM obra o WHERE o.id = f.obra_id;
