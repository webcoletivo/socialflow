import { createSign } from "crypto";
import {
  canonicalMonthFolderName,
  drivePathLabel,
  isStoryName,
  normalizeFolderName,
  parseArtStem,
  parseMonthKey,
  pickMonthFolder,
  pickYearFolder,
  resolveMonthFolder,
  storyFileStem,
  type DriveFolder,
  type DriveLayout,
} from "@/lib/drive-layout";

/**
 * Cliente mínimo da Google Drive API v3 usando uma service account.
 * Assina o JWT com node:crypto (RS256) e troca por um access token — sem
 * depender do SDK googleapis. Leitura + escrita (a SA precisa de permissão
 * de Editor na pasta raiz compartilhada para criar pastas/arquivos).
 *
 * A service account pode ser fornecida de duas formas (a primeira encontrada vence):
 *   1. GOOGLE_SERVICE_ACCOUNT_JSON — JSON completo inline (recomendado para Vercel/produção)
 *   2. GOOGLE_SERVICE_ACCOUNT_FILE — caminho relativo ao cwd para um arquivo .json (dev local)
 */

type ServiceAccount = { client_email: string; private_key: string };
type DriveFile = { id: string; name: string; mimeType: string };

let cachedSA: ServiceAccount | null = null;
let cachedToken: { value: string; expiresAt: number } | null = null;

function loadServiceAccount(): ServiceAccount {
  if (cachedSA) return cachedSA;

  let raw: string | undefined;

  // 1) Inline JSON (produção / Vercel) — aceita JSON puro OU base64 do JSON
  const inlineJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (inlineJson) {
    raw = inlineJson.startsWith("{")
      ? inlineJson
      : Buffer.from(inlineJson, "base64").toString("utf8");
  }

  // 2) Arquivo local (dev) — totalmente oculto do Turbopack via eval
  if (!raw) {
    const rel = process.env.GOOGLE_SERVICE_ACCOUNT_FILE;
    if (!rel) {
      throw new Error(
        "Nenhuma service account configurada. " +
        "Defina GOOGLE_SERVICE_ACCOUNT_JSON (produção) ou GOOGLE_SERVICE_ACCOUNT_FILE (dev)."
      );
    }
    const _require = eval("require") as NodeRequire;
    const nodePath: typeof import("path") = _require("path");
    const nodeFs: typeof import("fs") = _require("fs");
    const file = nodePath.resolve(process.cwd(), rel);
    try {
      raw = nodeFs.readFileSync(file, "utf8");
    } catch (e) {
      // o caminho do servidor fica só no log; a tela recebe "Drive não configurado" (user-facing-error)
      console.error("[drive] arquivo da service account ilegível:", file, e instanceof Error ? e.message : e);
      throw new Error(
        "Arquivo da service account não encontrado (GOOGLE_SERVICE_ACCOUNT_FILE). " +
        "Em produção, defina GOOGLE_SERVICE_ACCOUNT_JSON."
      );
    }
  }

  const json = JSON.parse(raw);
  if (!json.client_email || !json.private_key) {
    throw new Error("JSON da service account inválido");
  }
  // normaliza quebras de linha escapadas (\n literais) na chave privada —
  // pitfall comum ao colar a chave em variável de ambiente na Vercel
  cachedSA = {
    client_email: json.client_email,
    private_key: String(json.private_key).replace(/\\n/g, "\n"),
  };
  return cachedSA;
}

async function getAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now + 60) return cachedToken.value;

  const sa = loadServiceAccount();
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const header = b64({ alg: "RS256", typ: "JWT" });
  // Impersonação (domain-wide delegation, Workspace): com GOOGLE_IMPERSONATE_EMAIL
  // setado, a SA age como esse usuário e os arquivos ficam na conta dele —
  // contorna o "Service Accounts do not have storage quota" no Meu Drive.
  const impersonate = process.env.GOOGLE_IMPERSONATE_EMAIL?.trim();
  const claim = b64({
    iss: sa.client_email,
    ...(impersonate ? { sub: impersonate } : {}),
    // escopo com escrita: o plano básico salva as artes geradas no Drive
    scope: "https://www.googleapis.com/auth/drive",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  });
  const signingInput = `${header}.${claim}`;
  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    .sign(sa.private_key, "base64url");
  const assertion = `${signingInput}.${signature}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Falha ao autenticar no Google: ${res.status} ${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  cachedToken = { value: data.access_token, expiresAt: now + (data.expires_in ?? 3600) };
  return cachedToken.value;
}

function escapeQ(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function driveList(q: string): Promise<DriveFile[]> {
  const token = await getAccessToken();
  const all: DriveFile[] = [];
  let pageToken: string | undefined;

  // paginado: pastas de mês com 100+ arquivos não podem perder mídia
  do {
    const url = new URL("https://www.googleapis.com/drive/v3/files");
    url.searchParams.set("q", q);
    url.searchParams.set("fields", "nextPageToken,files(id,name,mimeType)");
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Drive list falhou: ${res.status} ${detail.slice(0, 200)}`);
    }
    const data = await res.json();
    all.push(...(data.files ?? []));
    pageToken = data.nextPageToken ?? undefined;
  } while (pageToken);

  return all;
}

/**
 * Lista as subpastas (não-lixeira) de um pai, ordenadas por nome (pt-BR).
 * Usado pelo seletor visual de pasta do cliente.
 */
export async function listFolders(parentId: string): Promise<{ id: string; name: string }[]> {
  const q =
    `'${escapeQ(parentId)}' in parents ` +
    `and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const files = await driveList(q);
  return files
    .map((f) => ({ id: f.id, name: f.name }))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

/**
 * Acha uma subpasta pelo nome dentro de um pai, sem diferenciar caixa nem
 * acento (ex.: "Café Ação" casa com "CAFE ACAO"). Usado para a pasta do
 * cliente. Com mais de uma candidata, vence a que só difere na caixa; depois,
 * a ordem alfabética.
 */
export async function findFolder(name: string, parentId: string): Promise<string | null> {
  const target = normalizeFolderName(name);
  const matches = (await listFolders(parentId)).filter((f) => normalizeFolderName(f.name) === target);
  const sameCase = matches.find((f) => f.name.trim().toLowerCase() === name.trim().toLowerCase());
  return (sameCase ?? matches[0])?.id ?? null;
}

/** Pasta do ano ("2026") dentro da pasta do cliente. */
export async function findYearFolder(
  clientFolderId: string,
  year: number
): Promise<{ folder: DriveFolder | null; ambiguous: string[] }> {
  return pickYearFolder(await listFolders(clientFolderId), year);
}

/**
 * Pasta do mês dentro de um pai (pasta do ano ou, na estrutura antiga, a do
 * cliente), pelos nomes aceitos: "outubro", "10", "10 - Outubro"…
 */
export async function findMonthFolder(
  parentId: string,
  month: number
): Promise<{ folder: DriveFolder | null; ambiguous: string[] }> {
  return pickMonthFolder(await listFolders(parentId), month);
}

/**
 * Formatos de mídia aceitos do Drive (OWASP AUD2 / CF-03): só o que as redes
 * publicam e o sharp decodifica com segurança. SVG (script embutido), HEIF/AVIF,
 * GIF, TIFF etc. ficam de fora — o arquivo não é escolhido e o post aparece como
 * "sem arte" com o caminho esperado. `ext` vem daqui, nunca do nome do arquivo.
 */
const DRIVE_MEDIA_TYPES: Readonly<Record<string, { ext: string; kind: "image" | "video" }>> = {
  "image/jpeg": { ext: "jpg", kind: "image" },
  "image/jpg": { ext: "jpg", kind: "image" },
  "image/png": { ext: "png", kind: "image" },
  "image/webp": { ext: "webp", kind: "image" },
  "video/mp4": { ext: "mp4", kind: "video" },
  "video/quicktime": { ext: "mov", kind: "video" },
  "video/webm": { ext: "webm", kind: "video" },
};

/** Tipo aceito (content-type normalizado, extensão e se é imagem/vídeo); null = formato recusado. */
export function driveMediaType(mime: string | null | undefined): { contentType: string; ext: string; kind: "image" | "video" } | null {
  const ct = String(mime ?? "").split(";")[0].trim().toLowerCase();
  const t = DRIVE_MEDIA_TYPES[ct];
  return t ? { contentType: ct === "image/jpg" ? "image/jpeg" : ct, ext: t.ext, kind: t.kind } : null;
}

function isMedia(f: DriveFile): boolean {
  return driveMediaType(f.mimeType) !== null;
}

/**
 * Conteúdo que é marcação (SVG/HTML/XML) apesar do tipo declarado: começa com
 * "<" depois de espaços/BOM. Nunca vai para o R2 nem é servido.
 */
export function looksLikeMarkup(buf: Uint8Array): boolean {
  let i = 0;
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) i = 3; // BOM UTF-8
  while (i < buf.length && i < 1024 && (buf[i] === 0x20 || buf[i] === 0x09 || buf[i] === 0x0a || buf[i] === 0x0d)) i++;
  return buf[i] === 0x3c; // "<"
}

// ------------------------------------------------------------ pasta dentro da raiz (OWASP AUD2-08)

/** ID de arquivo/pasta do Drive (letras, números, "-" e "_"). Outra coisa nunca vai para a API. */
const DRIVE_ID = /^[A-Za-z0-9_-]{10,128}$/;

export function isDriveId(id: string): boolean {
  return DRIVE_ID.test(id);
}

const ANCESTRY_TTL_MS = 10 * 60_000;
const ANCESTRY_MAX_DEPTH = 15;
const ancestryCache = new Map<string, { inside: boolean; at: number }>();

/**
 * Pais de um arquivo/pasta; null se não existir, estiver na lixeira ou a conta
 * do sistema não enxergar (404). Outro erro (403, 5xx) lança: na dúvida, a
 * pasta não é usada.
 */
async function parentsOf(id: string): Promise<string[] | null> {
  const token = await getAccessToken();
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`);
  url.searchParams.set("fields", "id,parents,trashed");
  url.searchParams.set("supportsAllDrives", "true");
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Drive list falhou: ${res.status} ${detail.slice(0, 200)}`);
  }
  const data = (await res.json()) as { parents?: string[]; trashed?: boolean };
  if (data.trashed) return null;
  return data.parents ?? [];
}

/**
 * A pasta é a raiz dos clientes (DRIVE_ROOT_FOLDER_ID) ou fica dentro dela?
 * A conta de serviço tem escopo de Drive inteiro: sem esta checagem, um ID
 * qualquer (em `?parent=` ou no cadastro do cliente) listaria ou gravaria em
 * pastas fora da agência ("confused deputy"). Sobe pelos pais via API, com
 * cache de 10 min por pasta.
 */
export async function isInsideRoot(folderId: string): Promise<boolean> {
  const root = process.env.DRIVE_ROOT_FOLDER_ID;
  if (!root || !isDriveId(folderId)) return false;
  if (folderId === root) return true;
  const now = Date.now();
  const cached = ancestryCache.get(folderId);
  if (cached && now - cached.at < ANCESTRY_TTL_MS) return cached.inside;

  let frontier = [folderId];
  const seen = new Set(frontier);
  let inside = false;
  for (let depth = 0; depth < ANCESTRY_MAX_DEPTH && frontier.length > 0 && !inside; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      const hit = ancestryCache.get(id);
      if (id !== folderId && hit && now - hit.at < ANCESTRY_TTL_MS) {
        if (hit.inside) inside = true;
        continue;
      }
      const parents = await parentsOf(id);
      for (const p of parents ?? []) {
        if (p === root) inside = true;
        else if (!seen.has(p)) {
          seen.add(p);
          next.push(p);
        }
      }
      if (inside) break;
    }
    frontier = next;
  }
  ancestryCache.set(folderId, { inside, at: now });
  return inside;
}

/** Mensagem (pt-BR) para pasta fora da raiz dos clientes. */
export const FOLDER_OUTSIDE_ROOT = "Essa pasta não fica dentro da pasta de clientes do Google Drive. Escolha uma pasta dentro dela.";

/** Só para testes: esquece o cache de ancestralidade. */
export function clearDriveAncestryCache(): void {
  ancestryCache.clear();
}

function stemOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? name.slice(0, dot) : name).trim();
}

/**
 * O nome (sem extensão) corresponde ao índice N do post?
 * Aceita as variações que a equipe realmente usa:
 *   "3", "03", "3 - Título do post", "3_final", "3.v2"
 * e, para story (`story` = true), o story de ordem `storyOrdinal`:
 *   1º: "3story", "3 story", "3-story", "03_STORY", "3 - story" (e "3story1")
 *   2º: "3story2", "3 story 2", "3-story-2", "03_STORY_2"… (3º: "3story3"…)
 * Sem story: nomes de story NÃO casam (e vice-versa) — evita a arte do story
 * ir parar no feed. Um story também não serve a outra ordem: "3story2" não é
 * o 1º story, "3story" não é o 2º. "31" nunca casa com N=3 (separador
 * obrigatório). Regra em `parseArtStem` (drive-layout).
 */
export function matchesIndexName(stem: string, idx: number, story: boolean, storyOrdinal = 1): boolean {
  const art = parseArtStem(stem);
  if (!art || art.index !== idx) return false;
  return story ? art.kind === "story" && art.ordinal === storyOrdinal : art.kind === "post";
}

/** Nomes exatos (sem espaços, minúsculas) do story de ordem `ordinal` do post N, do preferido ao aceito. */
function exactStoryStems(idx: number, ordinal: number): string[] {
  return ordinal === 1 ? [storyFileStem(idx, 1), `${idx}story1`] : [storyFileStem(idx, ordinal)];
}

/**
 * Acha a mídia (imagem OU vídeo) do post de índice `idx` na pasta do mês.
 * `story` seleciona o arquivo do story de ordem `storyOrdinal` ("Nstory",
 * "Nstory2"…). Retorna também os candidatos ambíguos (mais de um arquivo
 * casando) para diagnóstico.
 */
export async function findMediaForIndex(
  folderId: string,
  idx: number,
  story: boolean,
  storyOrdinal = 1
): Promise<{ file: DriveFile | null; ambiguous: string[] }> {
  const q = `'${escapeQ(folderId)}' in parents and trashed = false`;
  const files = await driveList(q);
  const matches = files.filter((f) => isMedia(f) && matchesIndexName(stemOf(f.name), idx, story, storyOrdinal));
  return pickBestMatch(matches, story ? exactStoryStems(idx, storyOrdinal) : [String(idx)]);
}

/**
 * Desempate quando mais de um arquivo casa: nome exato (o 1º dos `exactStems`
 * presente, ignorando espaços e caixa) > nome mais curto. `ambiguous` lista
 * todos os candidatos.
 */
function pickBestMatch(
  matches: DriveFile[],
  exactStems: string[]
): { file: DriveFile | null; ambiguous: string[] } {
  if (matches.length <= 1) return { file: matches[0] ?? null, ambiguous: [] };
  const normalized = (f: DriveFile) => stemOf(f.name).toLowerCase().replace(/\s+/g, "");
  const exact = exactStems.map((s) => matches.find((f) => normalized(f) === s)).find((f) => f !== undefined);
  const chosen = exact ?? [...matches].sort((a, b) => a.name.length - b.name.length)[0];
  return { file: chosen, ambiguous: matches.map((f) => f.name) };
}

/**
 * Story guardado dentro da subpasta "N/" do carrossel (o sync procura aqui
 * só depois da pasta do mês): "Nstory.*" ou só "story.*" para o 1º story,
 * "Nstory2.*" ou "story2.*" para o 2º…, já que a subpasta identifica o N.
 * Story de outro número ("4story" em "3/") não casa.
 */
export async function findStoryInFolder(
  folderId: string,
  idx: number,
  storyOrdinal = 1
): Promise<{ file: DriveFile | null; ambiguous: string[] }> {
  const q = `'${escapeQ(folderId)}' in parents and trashed = false`;
  const files = await driveList(q);
  const matches = files.filter((f) => {
    if (!isMedia(f)) return false;
    const art = parseArtStem(stemOf(f.name));
    return art?.kind === "story" && (art.index === idx || art.index === null) && art.ordinal === storyOrdinal;
  });
  const withIdx = exactStoryStems(idx, storyOrdinal);
  const withoutIdx = withIdx.map((s) => s.slice(String(idx).length));
  return pickBestMatch(matches, [...withIdx, ...withoutIdx]);
}

/**
 * Acha a subpasta do carrossel do post `idx` ("3", "03" ou "3 - Título").
 */
export async function findFolderForIndex(
  folderId: string,
  idx: number
): Promise<string | null> {
  const q =
    `'${escapeQ(folderId)}' in parents ` +
    `and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const folders = await driveList(q);
  const match = folders.find((f) => matchesIndexName(f.name, idx, false));
  return match?.id ?? null;
}

/**
 * Fallback de carrossel sem subpasta: arquivos "N-1.jpg", "N-2.jpg"… soltos
 * na pasta do mês, ordenados pelo K. Vazio se não houver nenhum.
 */
export async function findCarouselFilesForIndex(
  folderId: string,
  idx: number
): Promise<DriveFile[]> {
  const q = `'${escapeQ(folderId)}' in parents and trashed = false`;
  const files = await driveList(q);
  const withOrd = files
    .map((f) => {
      if (!isMedia(f)) return null;
      const m = stemOf(f.name).trim().toLowerCase().match(/^0*(\d+)\s*[._-]\s*0*(\d+)\s*$/);
      if (!m || Number(m[1]) !== idx) return null;
      return { file: f, ord: Number(m[2]) };
    })
    .filter((x): x is { file: DriveFile; ord: number } => x !== null)
    .sort((a, b) => a.ord - b.ord);
  return withOrd.map((x) => x.file);
}

/**
 * Lista as mídias de uma pasta (os slides da subpasta "N/" do carrossel),
 * ordenadas por nome (natural: 1,2,10). Arquivos de story ("3story.jpg",
 * "story.jpg", "3story2.jpg", "story2.jpg"…) ficam de fora: não são slides.
 */
export async function listFolderMedia(folderId: string): Promise<DriveFile[]> {
  const q = `'${escapeQ(folderId)}' in parents and trashed = false`;
  const files = (await driveList(q)).filter((f) => isMedia(f) && !isStoryName(f.name));
  return files.sort((a, b) => a.name.localeCompare(b.name, "pt-BR", { numeric: true }));
}

/** Baixa os bytes de um arquivo do Drive. */
export async function downloadFile(
  fileId: string
): Promise<{ buffer: Buffer; contentType: string }> {
  const token = await getAccessToken();
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("alt", "media");
  url.searchParams.set("supportsAllDrives", "true");

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Download falhou: ${res.status} ${detail.slice(0, 200)}`);
  }
  const contentType = res.headers.get("content-type") ?? "application/octet-stream";
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType };
}

export function driveConfigured(): boolean {
  const hasSA = !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON || !!process.env.GOOGLE_SERVICE_ACCOUNT_FILE;
  return hasSA && !!process.env.DRIVE_ROOT_FOLDER_ID;
}

/** E-mail da service account (para instruções de compartilhamento). */
export function serviceAccountEmail(): string | null {
  try {
    return loadServiceAccount().client_email;
  } catch {
    return null;
  }
}

/**
 * Acha a subpasta pelo nome (sem caixa nem acento, ver `findFolder`); se não
 * existir, cria. Retorna o ID.
 */
export async function ensureFolder(name: string, parentId: string): Promise<string> {
  const existing = await findFolder(name, parentId);
  if (existing) return existing;
  return createFolder(name, parentId);
}

export type EnsuredMonthFolder = {
  folderId: string;
  layout: DriveLayout;
  /** "Cliente/2026/10 - Outubro" ou "Cliente/outubro (estrutura antiga)" */
  path: string;
  /** pastas criadas agora, do pai para o filho ("2026", "10 - Outubro"); vazio se já existiam */
  created: string[];
  /** candidatas quando mais de uma pasta casou (ver `resolveMonthFolder`) */
  ambiguous: string[];
};

/**
 * Garante a pasta do mês de um cliente. Procura primeiro como o sync procura
 * (Cliente/AAAA/<mês> e, se faltar, a estrutura antiga Cliente/<mês>) e
 * reaproveita o que achar, com qualquer nome aceito ("Outubro", "10"…). Só
 * cria o que falta, com os nomes canônicos "2026" e "10 - Outubro". Assim um
 * cliente que usa a estrutura antiga não ganha uma pasta vazia que esconderia
 * a dele.
 */
export async function ensureYearMonthFolders(
  clientFolderId: string,
  monthKey: string,
  clientName = ""
): Promise<EnsuredMonthFolder> {
  const { year, month } = parseMonthKey(monthKey);
  const found = await resolveMonthFolder(listFolders, clientFolderId, year, month, clientName);
  if (found.folderId && found.layout) {
    return {
      folderId: found.folderId,
      layout: found.layout,
      path: drivePathLabel(clientName, year, month, "", found.layout, found),
      created: [],
      ambiguous: found.ambiguous,
    };
  }

  const created: string[] = [];
  let yearFolder = (await findYearFolder(clientFolderId, year)).folder;
  // o ano já existia: confere de novo o mês (outro processo pode tê-lo criado agora)
  let monthFolder = yearFolder ? (await findMonthFolder(yearFolder.id, month)).folder : null;
  if (!yearFolder) {
    const name = String(year);
    yearFolder = { id: await createFolder(name, clientFolderId), name };
    created.push(name);
  }
  if (!monthFolder) {
    const name = canonicalMonthFolderName(month);
    monthFolder = { id: await createFolder(name, yearFolder.id), name };
    created.push(name);
  }
  return {
    folderId: monthFolder.id,
    layout: "ano/mes",
    path: drivePathLabel(clientName, year, month, "", "ano/mes", {
      yearFolderName: yearFolder.name,
      monthFolderName: monthFolder.name,
    }),
    created,
    ambiguous: found.ambiguous,
  };
}

/** Cria uma subpasta (sem procurar antes). Retorna o ID. */
async function createFolder(name: string, parentId: string): Promise<string> {
  const token = await getAccessToken();
  const res = await fetch(
    "https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentId],
      }),
    }
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Drive criar pasta falhou: ${res.status} ${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.id as string;
}

/**
 * Sobe um arquivo para uma pasta do Drive (upload multipart). Se já existir
 * arquivo com o mesmo nome na pasta, substitui o conteúdo (evita duplicatas
 * ao regerar a arte).
 */
export async function uploadToDrive(
  name: string,
  parentId: string,
  buffer: Buffer,
  contentType: string
): Promise<string> {
  const token = await getAccessToken();

  // já existe? → update de conteúdo (media upload) no mesmo arquivo
  const q = `'${escapeQ(parentId)}' in parents and name = '${escapeQ(name)}' and trashed = false`;
  const found = await driveList(q);
  const existing = found[0];

  const boundary = "sfmedia" + Date.now().toString(36);
  const metadata = existing ? { name } : { name, parents: [parentId] };
  const head = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--`);
  const body = Buffer.concat([head, buffer, tail]);

  const url = existing
    ? `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=multipart&supportsAllDrives=true&fields=id`
    : "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id";

  const res = await fetch(url, {
    method: existing ? "PATCH" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body: new Uint8Array(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Drive upload falhou: ${res.status} ${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.id as string;
}
