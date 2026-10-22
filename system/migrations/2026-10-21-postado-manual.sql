-- Migração: "Marcar como postado" manual (calendário do /design)
--
-- Pedido do usuário (21/10): enquanto o sistema não publica sozinho, a equipe posta nas redes
-- e marca no calendário do Design que o post foi postado (quem e quando). Qualquer pessoa da
-- equipe pode desmarcar (fica no audit_log: post.posted_manual / post.unposted_manual).
--
-- Marcar = posts.status 'published' + posted_manually_at/posted_by preenchidos (a fila de
-- publicação e o resto do sistema já tratam 'published' como postado; nada é publicado de novo).
-- Desmarcar = volta para 'draft' e limpa os dois campos — só vale para marcação manual
-- (posted_manually_at não nulo); publicado pelo sistema não se desmarca.
--
-- Nenhum dado existente é alterado. Idempotente e tudo-ou-nada (BEGIN … COMMIT).
-- Ordem de deploy: rodar ESTA migração ANTES de subir o código novo (o Prisma do código novo lê
-- as colunas). O código antigo funciona com o banco novo (colunas novas aceitam NULL).
--   psql -h 127.0.0.1 -U <usuário> -d postgres -f 2026-10-21-postado-manual.sql

BEGIN;

ALTER TABLE posts ADD COLUMN IF NOT EXISTS posted_manually_at TIMESTAMPTZ;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS posted_by UUID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_posts_posted_by') THEN
    ALTER TABLE posts ADD CONSTRAINT fk_posts_posted_by
      FOREIGN KEY (posted_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

COMMIT;

-- Conferência:
--   -- 2 linhas: posted_manually_at (timestamp with time zone), posted_by (uuid)
--   SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name = 'posts' AND column_name IN ('posted_manually_at', 'posted_by');
--
--   -- 1 linha: a chave estrangeira
--   SELECT conname FROM pg_constraint WHERE conname = 'fk_posts_posted_by';
