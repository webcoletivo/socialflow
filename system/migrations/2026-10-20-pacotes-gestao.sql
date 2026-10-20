-- Migração: pacotes de gestão + e-mail principal repetível em qualquer plano
--
-- Pedido do usuário (20/10):
--   1) o e-mail principal do cliente pode repetir em QUALQUER plano (também com aprovação):
--      há clientes em que a aprovação vai para uma única pessoa (ex.: Mania de Passar).
--      → remove o índice único parcial uq_clients_email_aprovacao (criado em
--        2026-10-07-email-cliente-sem-aprovacao.sql). clients.email fica sem unicidade.
--   2) pacotes de gestão (Gestão 1 · Gestão 2 · Gestão 3 (Stories) · Gestão Reels), 1 ciclo = 1 mês.
--      clients.tier passa a aceitar: gestao_1 | gestao_2 | gestao_3_stories | gestao_reels |
--      basica | completa (antigo). A coluna já é TEXT sem restrição: nada muda nela.
--      → clients.carousel_frequency: 'semanal' | 'quinzenal' (padrão 'quinzenal')
--      → clients.reels_weekday: 1–5 = seg–sex; NULL quando o pacote não tem reels
--      → posts.content_kind: tipo do conteúdo no pacote (NULL = sem tipo / posts antigos):
--        estatico | carrossel | reels | reels_gravado | reels_banco | banner_animado |
--        story_exclusivo | story_replica
--
-- Nenhum dado existente é alterado: clientes "completa" continuam "completa" (a tela pede para
-- escolher um pacote) e os posts antigos ficam com content_kind NULL.
-- Idempotente (pode rodar mais de uma vez) e tudo-ou-nada (BEGIN … COMMIT).
-- Não usar `prisma db push` neste banco.
--
-- Ordem de deploy: rodar ESTA migração ANTES de subir o código novo (o Prisma do código novo lê
-- as colunas novas). O código antigo funciona com o banco novo (colunas novas têm padrão/NULL).
--   psql "$DATABASE_URL" -f system/migrations/2026-10-20-pacotes-gestao.sql

BEGIN;

-- 1) e-mail principal repetível em qualquer plano
DROP INDEX IF EXISTS uq_clients_email_aprovacao;

-- 2) campos do pacote no cliente
ALTER TABLE clients ADD COLUMN IF NOT EXISTS carousel_frequency TEXT NOT NULL DEFAULT 'quinzenal';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS reels_weekday SMALLINT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_clients_carousel_frequency') THEN
    ALTER TABLE clients ADD CONSTRAINT ck_clients_carousel_frequency
      CHECK (carousel_frequency IN ('semanal', 'quinzenal'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_clients_reels_weekday') THEN
    ALTER TABLE clients ADD CONSTRAINT ck_clients_reels_weekday
      CHECK (reels_weekday IS NULL OR reels_weekday BETWEEN 1 AND 5);
  END IF;
END $$;

-- 3) tipo do conteúdo no pacote
ALTER TABLE posts ADD COLUMN IF NOT EXISTS content_kind TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_posts_content_kind') THEN
    ALTER TABLE posts ADD CONSTRAINT ck_posts_content_kind
      CHECK (content_kind IS NULL OR content_kind IN (
        'estatico', 'carrossel', 'reels', 'reels_gravado', 'reels_banco',
        'banner_animado', 'story_exclusivo', 'story_replica'
      ));
  END IF;
END $$;

COMMIT;

-- Conferência:
--   -- 0 linhas: o índice único parcial do e-mail não existe mais
--   SELECT indexname FROM pg_indexes WHERE indexname = 'uq_clients_email_aprovacao';
--
--   -- 0 linhas: nenhuma unicidade em clients.email
--   SELECT indexname FROM pg_indexes WHERE tablename = 'clients' AND indexdef ILIKE 'CREATE UNIQUE INDEX%email%';
--
--   -- 3 linhas: carousel_frequency (text, 'quinzenal'), reels_weekday (smallint), content_kind (text)
--   SELECT table_name, column_name, data_type, column_default FROM information_schema.columns
--   WHERE (table_name = 'clients' AND column_name IN ('carousel_frequency', 'reels_weekday'))
--      OR (table_name = 'posts' AND column_name = 'content_kind');
--
--   -- 3 linhas: as restrições novas
--   SELECT conname FROM pg_constraint
--   WHERE conname IN ('ck_clients_carousel_frequency', 'ck_clients_reels_weekday', 'ck_posts_content_kind');
