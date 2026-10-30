-- CV pedido à mão pelo painel ("Coletar CV pelo link") passa na frente da fila.
ALTER TABLE fila ADD COLUMN prioridade int NOT NULL DEFAULT 0;
CREATE INDEX fila_proxima ON fila (prioridade DESC, criado_em, lattes_id) WHERE status = 'pendente';
