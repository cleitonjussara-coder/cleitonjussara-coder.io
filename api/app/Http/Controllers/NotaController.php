<?php

namespace App\Http\Controllers;

use App\Models\Colaborador;
use App\Models\Nota;
use App\Services\FotoEmBrancoAviso;
use App\Services\FotoStorage;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

/**
 * Notas de despesa. As regras de acesso são as policies do Supabase:
 *   ver      → dono, ou gestor/admin (todos os núcleos)
 *   gravar   → dono, ou gestor/admin
 *   apagar   → dono, ou gestor/admin. Era só dono/admin (migração 2026-09-10);
 *              em 23/10/2026 o gestor entrou: ele é o cargo maior da empresa, e a
 *              nota de Faturamento sem colaborador (que só ele lança) não tem
 *              dono — sem isto nem dava para limpar da lixeira.
 */
class NotaController extends Controller
{
    public function __construct(private FotoStorage $fotos, private FotoEmBrancoAviso $fotoBranca) {}

    /**
     * GET /notas?since=…&ano=…&mes=…&user_id=…&deleted=0|1|all&fields=a,b
     * `deleted` sem valor = tudo (o pull incremental precisa das apagadas
     * para propagar a lixeira entre aparelhos).
     */
    public function index(Request $r): JsonResponse
    {
        $u = $r->user();
        $q = Nota::query()->visiveisPara($u);

        if ($since = $r->query('since')) {
            /* O app manda ISO ("2026-09-20T02:43:49.923Z"); o SQLite guarda
               "2026-09-20 02:43:49" e compara como TEXTO — o "T" é maior que
               o espaço, então linhas alteradas no MESMO dia ficavam de fora
               do sync incremental (achado em 20/09/2026). Normaliza para o
               formato do banco, em UTC. */
            try {
                $since = \Carbon\Carbon::parse($since)->utc()->format('Y-m-d H:i:s');
            } catch (\Throwable) {
            }
            $q->where('updated_at', '>=', $since);
        }
        if ($r->filled('ano')) {
            $q->where('ano', (int) $r->query('ano'));
        }
        if ($r->filled('mes')) {
            $q->where('mes', (int) $r->query('mes'));
        }
        if ($r->filled('user_id')) {
            $q->where('user_id', $r->query('user_id'));
        }
        if (in_array($r->query('deleted'), ['0', '1'], true)) {
            $q->where('deleted', $r->query('deleted') === '1');
        }
        if ($r->filled('fields')) {
            $cols = array_values(array_intersect(
                explode(',', $r->query('fields')),
                array_merge(['id', 'user_id', 'created_by', 'updated_by', 'created_at', 'updated_at'], (new Nota)->getFillable())
            ));
            if ($cols) {
                $q->select(array_unique(array_merge(['id'], $cols)));
            }
        }

        /* ordem padrão do app: data desc, depois criação desc */
        $q->orderByDesc('data')->orderByDesc('created_at');

        return response()->json($q->get());
    }

    /** PUT /notas/{id} — upsert pelo id gerado no aparelho. */
    public function upsert(Request $r, string $id): JsonResponse
    {
        $u = $r->user();
        /* O app pode mandar CNPJ e chave formatados; o banco guarda só dígitos. */
        foreach (['cnpj', 'chave_nfce', 'consumidor'] as $campo) {
            if ($r->filled($campo)) {
                $r->merge([$campo => preg_replace('/\D/', '', (string) $r->input($campo)) ?: null]);
            }
        }
        /* 21/10/2026: recibo sem CNPJ chegava como "00000000000000" (BrasilAPI.limpar('') do app antigo): zero não é CNPJ, grava vazio */
        if (preg_match('/^0+$/', (string) $r->input('cnpj'))) {
            $r->merge(['cnpj' => null]);
        }
        /* 25/09/2026: 'reembolso' virou 'carteira'. Um aparelho que ficou offline
           durante a troca pode ter isso na fila de sincronização — normaliza
           aqui em vez de recusar o lançamento com 422 pra sempre. */
        if ($r->input('pagamento') === 'reembolso') {
            $r->merge(['pagamento' => 'carteira']);
        }
        /* Faturamento sem colaborador (28/09/2026): "muitas vezes vai ter
           Faturamento que não terá como especificar" de quem é — só essa
           nota pode nascer sem dono. String vazia normaliza pra null antes
           de validar (o app manda '' quando o gestor não escolhe ninguém). */
        if ($r->input('user_id') === '') {
            $r->merge(['user_id' => null]);
        }
        $d = $r->validate([
            'user_id' => [
                Rule::requiredIf(fn () => $r->input('pagamento') !== 'empresa'),
                'nullable', 'string', 'size:36', Rule::exists('colaboradores', 'id'),
            ],
            'tipo' => ['required', Rule::in(Nota::TIPOS)],
            'subtipo' => ['nullable', Rule::in(Nota::SUBTIPOS)],
            'pagamento' => ['nullable', Rule::in(Nota::PAGAMENTOS)],   // colaborador CV: cartão ou do bolso (21/09/2026)
            'cnpj' => ['nullable', 'string', 'max:14'],
            'consumidor' => ['nullable', 'string', 'max:14'],   // CPF/CNPJ no cupom (24/09/2026)
            'razao_social' => ['nullable', 'string', 'max:255'],
            'valor' => ['required', 'numeric', 'min:0'],
            'data' => ['required', 'date_format:Y-m-d'],
            'mes' => ['required', 'integer', 'between:1,12'],
            'ano' => ['required', 'integer', 'min:2020'],
            'metodo_captura' => ['nullable', 'string', 'max:20'],
            'chave_nfce' => ['nullable', 'string', 'max:44'],
            'uf' => ['nullable', 'string', 'size:2'],
            'modelo' => ['nullable', 'string', 'size:2'],
            'documento' => ['nullable', Rule::in(Nota::DOCUMENTOS)],
            'numero' => ['nullable', 'string', 'max:40'],
            // 24/09/2026: séries com mais de 6 dígitos existem (NFS-e); o limite era 5.
            'serie' => ['nullable', 'string', 'max:20'],
            'foto_path' => ['nullable', 'string', 'max:255'],
            'qr_url' => ['nullable', 'string'],
            'observacao' => ['nullable', 'string'],
            'deleted' => ['nullable', 'boolean'],
            'created_at' => ['nullable', 'date'],
        ]);



        /* 24/09/2026: HOJE é o presente — nada é gravado com data adiante
           dele. O app já barra na hora de salvar; aqui o servidor garante,
           inclusive para aparelho com app antigo.
           Até dois dias à frente o registro NÃO é recusado, e sim trazido
           para hoje: nesse intervalo a causa quase sempre é relógio de
           celular adiantado, e recusar deixaria o lançamento preso no
           aparelho para sempre, sem conseguir subir. Mais que isso é
           absurdo (a nota que veio com 2045) e aí sim é recusado. */
        if (! empty($d['data'])) {
            $hoje = \Illuminate\Support\Carbon::now('America/Sao_Paulo')->startOfDay();
            $dataInformada = \Illuminate\Support\Carbon::parse($d['data'])->startOfDay();
            if ($dataInformada->greaterThan($hoje)) {
                if ($hoje->diffInDays($dataInformada) > 2) {
                    abort(422, 'A data está no futuro (' . $d['data'] . '). O lançamento registra algo que já aconteceu — corrija a data.');
                }
                Log::warning('data no futuro trazida para hoje', [
                    'id' => $id,
                    'veio' => $d['data'],
                    'gravado' => $hoje->format('Y-m-d'),
                ]);
                $d['data'] = $hoje->format('Y-m-d');
            }
        }
        /* 24/09/2026: mês e ano SEGUEM A DATA, sempre. Chegavam do aparelho
           e podiam vir do filtro da tela ou de uma chave de NFS-e mal
           formada — foi assim que uma nota de 22/09/2026 foi gravada em
           2045 e sumiu de toda lista filtrada por período. Corrigir aqui
           protege também o aparelho que ainda não atualizou o app. */
        if (! empty($d['data'])) {
            $dt = \Illuminate\Support\Carbon::parse($d['data']);
            $mesCerto = (int) $dt->format('n');
            $anoCerto = (int) $dt->format('Y');
            if ((int) ($d['mes'] ?? 0) !== $mesCerto || (int) ($d['ano'] ?? 0) !== $anoCerto) {
                Log::warning('mes/ano corrigidos pela data', [
                    'id' => $id,
                    'veio' => ($d['mes'] ?? '?') . '/' . ($d['ano'] ?? '?'),
                    'data' => $dt->format('Y-m-d'),
                ]);
            }
            $d['mes'] = $mesCerto;
            $d['ano'] = $anoCerto;
        }
        $nota = Nota::find($id);
        /* Nota NOVA só nasce com id em formato UUID (24/10/2026): o app sempre gera com crypto.randomUUID(), e o id vai parar
           em atributos de HTML (onclick, data-*) em várias telas — um id com aspas seria código rodando na tela do gestor.
           Nota que já existe segue como está. */
        if (! $nota) {
            abort_unless(Str::isUuid($id), 422, 'Identificador de nota inválido.');
        }
        $this->podeGravar($u, $d['user_id'], $nota !== null);
        if ($nota) {
            $this->podeGravar($u, $nota->user_id, true);
        }
        /* Contador (14/10/2026, pedido do Cleiton): corrige a nota que está
           incorreta — mas só ela. Não lança nota nova (podeGravar), não a
           manda para a lixeira e não troca de quem ela é. */
        if ($u->soLeitura()) {
            abort_if($nota->deleted || ($d['deleted'] ?? false), 403, 'Contabilidade corrige notas, mas não as exclui.');
            abort_unless(($d['user_id'] ?? null) === $nota->user_id, 403, 'Contabilidade não troca o dono da nota.');
        }
        /* 25/09/2026: nota de Faturamento (paga direto pela empresa, exclui do
           saldo/cartão de quem for escolhido) só gestor ou admin lança —
           mesma regra vale editando uma nota já existente. */
        $pagamentoAlvo = $d['pagamento'] ?? $nota?->pagamento;
        abort_if($pagamentoAlvo === 'empresa' && ! $u->gerencia(), 403, 'Só gestor ou admin lança nota de Faturamento.');

        $d['metodo_captura'] = $d['metodo_captura'] ?? 'manual';
        $d['deleted'] = (bool) ($d['deleted'] ?? false);

        if ($nota) {
            /* foto_path vazio do app NÃO é remoção: o anexo é obrigatório e o
               app nunca tira, então null aqui é a cópia local que ficou para
               trás. Só troca quando o app manda um caminho. */
            if (empty($d['foto_path'])) {
                unset($d['foto_path']);
            }
            unset($d['created_at']);
            $nota->fill($d);
            $nota->updated_by = $u->id;
            $nota->save();
        } else {
            /* ANEXO OBRIGATÓRIO também aqui, não só na tela: nota nova só entra
               se o arquivo dela já estiver no disco (o app sobe a foto ANTES
               de gravar a nota — POST /notas/{id}/foto aceita nota que ainda
               não existe). O caminho vem do disco, nunca do que o app mandou.
               Nota que já nasce na lixeira passa sem anexo: não é lançamento. */
            $arquivo = $this->fotos->arquivoDaNota($d['user_id'] ?? Nota::PASTA_GERAL, $id);
            if ($arquivo === null && ! $d['deleted']) {
                throw ValidationException::withMessages([
                    'foto_path' => 'Anexo obrigatório: envie a foto ou o arquivo da nota antes de gravá-la.',
                ]);
            }
            $d['foto_path'] = $arquivo;
            $nota = new Nota(['id' => $id] + $d);
            $nota->created_by = $u->id;
            $nota->updated_by = $u->id;
            $nota->save();
        }

        /* Foto em branco (21/10/2026): mede o anexo se ainda não foi medido (nota nova, ou antiga que acabou de ser
           editada). Só marca e avisa a gestão; nunca recusa nem apaga, e erro aqui nunca derruba o envio. */
        $this->fotoBranca->avaliar($nota, $u);

        return response()->json($nota->fresh());
    }

    /** DELETE /notas/{id} — definitivo: arquivo + linha. */
    /**
     * PATCH /notas/{id}/tipo {tipo, subtipo} — gestor/admin corrige o
     * lançamento que o colaborador pôs no grupo errado (23/09/2026).
     *
     * Mexe só em tipo/subtipo: valor, anexo, CNPJ e o resto da nota ficam
     * como estão. RDA não tem categoria, então o subtipo é limpo ao virar
     * RDA. O save() atualiza updated_at, que é como o aparelho do dono puxa
     * a correção no próximo sync.
     */
    public function corrigirTipo(Request $r, string $id): JsonResponse
    {
        $u = $r->user();
        /* gestor, admin e (desde 14/10/2026) contabilidade corrigem o grupo */
        abort_unless($u->veTudo(), 403, 'Só gestor, admin ou contabilidade corrigem o grupo de uma nota');

        $d = $r->validate([
            'tipo' => ['required', Rule::in(Nota::TIPOS)],
            'subtipo' => ['nullable', Rule::in(Nota::SUBTIPOS)],
        ]);

        $nota = Nota::findOrFail($id);
        abort_if($nota->deleted, 404, 'Nota excluída');

        $antes = $nota->tipo.($nota->subtipo ? ' · '.$nota->subtipo : '');
        $tipo = $d['tipo'];
        $subtipo = $tipo === 'RDM' ? ($d['subtipo'] ?? null) : null;

        if ($tipo === $nota->tipo && $subtipo === $nota->subtipo) {
            return response()->json(['nota' => $nota, 'mudou' => false]);
        }

        $nota->forceFill(['tipo' => $tipo, 'subtipo' => $subtipo, 'updated_by' => $u->id])->save();
        Log::warning('nota corrigida pelo gestor', [
            'nota' => $nota->id, 'de' => $antes,
            'para' => $tipo.($subtipo ? ' · '.$subtipo : ''),
            'por' => $u->email, 'dono' => $nota->user_id,
        ]);

        return response()->json(['nota' => $nota->fresh(), 'mudou' => true]);
    }

    /* Ids apagados em definitivo desde `since`, para o app limpar o que
       ainda tem guardado (25/09/2026). Só ids — nada da nota sobrevive.
       26/09/2026: com `detalhe=1` devolve a linha inteira da lápide
       (quem apagou, de quem era, quando) — usado pelo Histórico do
       gestor/admin; o uso original (limpeza da lixeira local) continua
       pedindo só os ids, sem esse parâmetro. */
    public function apagadas(Request $r): JsonResponse
    {
        $u = $r->user();
        $q = DB::table('notas_apagadas');

        if ($since = $r->query('since')) {
            try {
                $since = \Carbon\Carbon::parse($since)->utc()->format('Y-m-d H:i:s');
            } catch (\Throwable) {
            }
            $q->where('apagada_em', '>=', $since);
        }
        /* Quem não enxerga a equipe só precisa saber das próprias. */
        if (! $u->veTudo()) {
            $q->where('user_id', $u->id);
        }

        if ($r->boolean('detalhe')) {
            /* 16/10/2026: DB::table devolve a data crua ("2026-10-17 00:57:00", em UTC e SEM fuso), diferente dos models, que
               saem em ISO com "Z". O Histórico lia essa data como horário local — mostrava 00:57 de 17/10 para um apagamento
               das 21:57 de 16/10 — e a ordenava como texto, fora de lugar. Agora sai em ISO UTC, como o resto. */
            return response()->json(
                $q->orderByDesc('apagada_em')->limit(500)->get(['id', 'user_id', 'apagada_por', 'apagada_em'])
                    ->map(function ($l) {
                        $l->apagada_em = $l->apagada_em ? \Carbon\Carbon::parse($l->apagada_em, 'UTC')->toISOString() : null;

                        return $l;
                    })->values()
            );
        }

        return response()->json($q->orderBy('apagada_em')->limit(5000)->pluck('id'));
    }

    public function destroy(Request $r, string $id): JsonResponse
    {
        $u = $r->user();
        $nota = Nota::findOrFail($id);
        abort_unless($nota->user_id === $u->id || $u->gerencia(), 403, 'Só o dono, o gestor ou o admin apagam em definitivo');

        /* Quem não é o dono só apaga o que já está na lixeira (23/10/2026). A Lixeira do app já filtra assim, mas a nota
           sem dono é de todos os gestores: se um restaura enquanto outro está com a Lixeira aberta, o segundo apagaria
           uma nota VIVA, com o anexo, sem volta. */
        abort_if($nota->user_id !== $u->id && ! $nota->deleted, 409, 'Esta nota não está na lixeira (foi restaurada?). Atualize a tela.');

        /* A lápide (25/09/2026): sem ela a linha some e o sync incremental
           nunca conta aos outros aparelhos que a nota foi apagada — a cópia
           local ficava para sempre, aparecendo em pendências.

           Ela vem ANTES da foto: se falhar (migração ainda não aplicada, por
           exemplo), nada foi perdido e dá para tentar de novo. Na ordem
           inversa a foto já tinha ido e a nota ficava. */
        DB::table('notas_apagadas')->updateOrInsert(
            ['id' => $nota->id],
            ['user_id' => $nota->user_id, 'apagada_por' => $u->id, 'apagada_em' => now()],
        );
        $this->fotos->apagarTodasVersoes($nota);
        if (\App\Models\AvisoCorrecao::tabelaExiste()) {
            \App\Models\AvisoCorrecao::where('nota_id', $nota->id)->delete();   // 24/10/2026: os avisos da nota vão junto
        }
        $nota->delete();

        return response()->json(['ok' => true]);
    }

    /**
     * POST /notas/existem {ids:[…]} → {notas:[{id, deleted}]} só das que o
     * usuário pode ver. A lixeira do aparelho usa isto para separar o que
     * ainda existe no servidor do que é cópia órfã (só local) — 20/09/2026.
     */
    public function existem(Request $r): JsonResponse
    {
        $u = $r->user();
        $d = $r->validate(['ids' => ['required', 'array', 'max:500'], 'ids.*' => ['string', 'size:36']]);
        $rows = Nota::query()->visiveisPara($u)->whereIn('id', $d['ids'])->get(['id', 'deleted']);

        return response()->json(['notas' => $rows->map(fn ($n) => ['id' => $n->id, 'deleted' => (bool) $n->deleted])->values()]);
    }

    /**
     * POST /notas/consultar-qr {qr_url, chave} → {valor, data, cnpj, razao_social, fonte} | null
     * Valor oficial da NFC-e pela URL do QR (ver App\Services\SefazPorQr).
     */
    public function consultarQr(Request $r, \App\Services\SefazPorQr $sefaz): JsonResponse
    {
        $d = $r->validate([
            'qr_url' => ['required', 'string', 'max:1000'],
            'chave' => ['nullable', 'string', 'max:60'],
        ]);

        return response()->json($sefaz->consultar($d['qr_url'], $d['chave'] ?? null));
    }

    /**
     * POST /notas/ler-foto (multipart: file) → {dados: {cnpj, razao_social, valor, data, numero, serie, chave}|null, motivo}
     * IA de visão lê a foto da nota — só SUGERE; o app preenche o formulário e a
     * pessoa confere. Cada campo é validado (CNPJ, chave, data, valor) antes de
     * sair (App\Services\LeitorNota). Limite diário por colaborador.
     */
    public function lerFoto(Request $r, \App\Services\LeitorNota $leitor): JsonResponse
    {
        $r->validate(['file' => ['required', 'file', 'mimetypes:image/jpeg,image/png,image/webp', 'max:6144']]);
        if (! $leitor->disponivel()) {
            return response()->json(['dados' => null, 'motivo' => 'indisponivel']);
        }

        $chave = 'nota-ia:'.$r->user()->id.':'.now('America/Sao_Paulo')->format('Y-m-d');
        $limite = (int) config('petermann.anthropic.limite_dia_notas');
        if ($limite > 0 && (int) \Illuminate\Support\Facades\Cache::get($chave, 0) >= $limite) {
            return response()->json(['dados' => null, 'motivo' => 'limite']);
        }
        \Illuminate\Support\Facades\Cache::add($chave, 0, now()->addDay());
        \Illuminate\Support\Facades\Cache::increment($chave);

        $arq = $r->file('file');
        $dados = $leitor->ler((string) file_get_contents($arq->getRealPath()), (string) $arq->getMimeType());
        /* só na homologação: registra o que a IA devolveu (já validado, sem razão social) para comparar com a nota — o nível de log da homologação é warning */
        if (app()->environment('staging')) {
            Log::warning('LeitorNota[leitura]', ['user' => $r->user()->id, 'bytes' => $arq->getSize(), 'dados' => $dados ? array_diff_key($dados, ['razao_social' => 1]) : null]);
        }

        if ($dados === null) {
            /* caso de 12/10/2026: o app recebia "nao_leu" e o servidor não deixava rastro. Agora fica quem, o tamanho
               do arquivo e o motivo (o aviso do VisaoIa logo acima diz o detalhe da API). */
            Log::warning('LeitorNota[nao_leu]', ['user' => $r->user()->id, 'bytes' => $arq->getSize(), 'mime' => $arq->getMimeType(), 'motivo' => $leitor->ultimoMotivo()]);
        }

        return response()->json(['dados' => $dados, 'motivo' => $dados === null ? 'nao_leu' : null, 'detalhe' => $dados === null ? $leitor->ultimoMotivo() : null]);
    }

    /**
     * POST /notas/chave-existe {chave, ignore_id}
     * Trava anti-duplicata de EQUIPE: a chave já existe em QUALQUER
     * colaborador? Devolve só sim/não (era a função SECURITY DEFINER
     * chave_nfce_existe — não expõe dados de outros).
     */
    public function chaveExiste(Request $r): JsonResponse
    {
        $d = $r->validate([
            'chave' => ['required', 'string'],
            'ignore_id' => ['nullable', 'string', 'size:36'],
        ]);
        $chave = preg_replace('/\D/', '', $d['chave']);
        $existe = strlen($chave) === 44 && Nota::query()
            ->where('chave_nfce', $chave)
            ->where('deleted', false)
            ->when($d['ignore_id'] ?? null, fn ($q, $ig) => $q->where('id', '<>', $ig))
            ->exists();

        return response()->json(['existe' => $existe]);
    }

    /**
     * POST /notas/duplicada {chave?, qr_url?, tipo?, cnpj?, razao_social?, valor?, data?, numero?, serie?, ignore_id?}
     *   → {existe, motivo, origem} (+ nota, só para quem pode ver a nota)
     *
     * Trava anti-duplicata de EQUIPE com as mesmas regras do app (21/10/2026):
     *   chave  → mesma chave de 44 dígitos
     *   nfse   → mesma consulta pública da NFS-e (chave de 50 dígitos)
     *   numero → mesmo fornecedor + mesmo número (série igual quando as duas têm)
     *   igual  → mesmo fornecedor + mesmo dia + mesmo valor + mesmo grupo (RDA/RDM)
     * "Fornecedor" é o CNPJ quando os dois têm; senão a razão social.
     *
     * Roda sobre TODAS as notas vivas, inclusive Faturamento sem colaborador
     * (user_id nulo) e as de outras pessoas — o aparelho do colaborador só
     * guarda as dele, e era por isso que a mesma nota lançada antes pelo
     * Faturamento passava batido. Lixeira não conta.
     *
     * Privacidade: quem não vê a equipe (colaborador comum) recebe só sim/não,
     * o motivo e de onde vem ('sua', 'faturamento' ou 'colaborador') — nunca
     * a nota nem o nome de ninguém. Gestor, admin e contabilidade, que já
     * enxergam tudo, recebem também o resumo da nota para abri-la.
     */
    public function duplicada(Request $r): JsonResponse
    {
        $d = $r->validate([
            'chave' => ['nullable', 'string', 'max:60'],
            'qr_url' => ['nullable', 'string', 'max:2000'],
            'tipo' => ['nullable', Rule::in(Nota::TIPOS)],
            'cnpj' => ['nullable', 'string', 'max:30'],
            'razao_social' => ['nullable', 'string', 'max:255'],
            'valor' => ['nullable', 'numeric'],
            'data' => ['nullable', 'date_format:Y-m-d'],
            'numero' => ['nullable', 'string', 'max:40'],
            'serie' => ['nullable', 'string', 'max:20'],
            'ignore_id' => ['nullable', 'string', 'size:36'],
        ]);
        $u = $r->user();

        $chave = preg_replace('/\D/', '', (string) ($d['chave'] ?? ''));
        $chave = strlen($chave) === 44 ? $chave : '';
        $qrUrl = trim((string) ($d['qr_url'] ?? ''));
        $cand = [
            'tipo' => $d['tipo'] ?? null,
            'cnpj' => self::cnpjValido($d['cnpj'] ?? null),
            'razao' => self::razaoNormalizada($d['razao_social'] ?? null),
            'numero' => self::numeroNormalizado($d['numero'] ?? null),
            'serie' => trim((string) ($d['serie'] ?? '')),
            'centavos' => isset($d['valor']) ? (int) round(((float) $d['valor']) * 100) : 0,
            'data' => $d['data'] ?? null,
        ];

        /* Candidatas: tudo que casa por chave, link da NFS-e, número ou dia+valor.
           O resto (fornecedor, série, grupo) é conferido em PHP, com a mesma
           lógica do app, em cima de um conjunto pequeno. */
        $q = Nota::query()->where('deleted', false)
            ->when($d['ignore_id'] ?? null, fn ($q, $ig) => $q->where('id', '<>', $ig))
            ->where(function ($q) use ($chave, $qrUrl, $cand) {
                $q->whereRaw('0 = 1');
                if ($chave !== '') {
                    $q->orWhere('chave_nfce', $chave);
                }
                if ($qrUrl !== '') {
                    $q->orWhere('qr_url', $qrUrl);
                }
                if ($cand['numero'] !== '') {
                    $q->orWhereRaw("ltrim(numero, '0') = ?", [$cand['numero']]);
                }
                if ($cand['centavos'] > 0 && $cand['data']) {
                    $q->orWhere(fn ($q) => $q->where('data', $cand['data'])->whereRaw('abs(valor - ?) < 0.005', [$cand['centavos'] / 100]));
                }
            });

        $achada = null;
        $motivo = null;
        foreach ($q->orderBy('created_at')->limit(200)->get() as $n) {
            $m = $this->motivoDuplicata($n, $chave, $qrUrl, $cand);
            if ($m !== null && ($motivo === null || self::FORCA_MOTIVO[$m] > self::FORCA_MOTIVO[$motivo])) {
                [$achada, $motivo] = [$n, $m];
            }
        }

        if (! $achada) {
            return response()->json(['existe' => false, 'motivo' => null, 'origem' => null]);
        }

        $origem = $achada->user_id === null ? 'faturamento' : ($achada->user_id === $u->id ? 'sua' : 'colaborador');
        $resp = ['existe' => true, 'motivo' => $motivo, 'origem' => $origem];
        if ($u->veTudo() || $achada->user_id === $u->id) {
            $resp['nota'] = [
                'id' => $achada->id, 'tipo' => $achada->tipo, 'subtipo' => $achada->subtipo,
                'razao_social' => $achada->razao_social, 'cnpj' => $achada->cnpj, 'numero' => $achada->numero,
                'data' => $achada->data?->format('Y-m-d'), 'valor' => (float) $achada->valor,
                'user_id' => $achada->user_id,
                'dono_nome' => $achada->user_id === null ? null : ($achada->dono?->nome),
            ];
        }

        return response()->json($resp);
    }

    /** Do mais forte para o mais fraco: quando várias notas casam, vale o melhor motivo. */
    private const FORCA_MOTIVO = ['chave' => 4, 'nfse' => 3, 'numero' => 2, 'igual' => 1];

    private function motivoDuplicata(Nota $n, string $chave, string $qrUrl, array $cand): ?string
    {
        if ($chave !== '' && preg_replace('/\D/', '', (string) $n->chave_nfce) === $chave) {
            return 'chave';
        }
        if ($qrUrl !== '' && trim((string) $n->qr_url) === $qrUrl) {
            return 'nfse';
        }
        if (! $this->mesmoFornecedor($n, $cand)) {
            return null;
        }
        $num = self::numeroNormalizado($n->numero);
        $serieDaNota = trim((string) $n->serie);
        if ($num !== '' && $num === $cand['numero'] && ($cand['serie'] === '' || $serieDaNota === '' || $cand['serie'] === $serieDaNota)) {
            return 'numero';
        }
        if ($cand['centavos'] > 0 && (int) round(((float) $n->valor) * 100) === $cand['centavos']
            && $cand['data'] && $n->data?->format('Y-m-d') === $cand['data']
            && $cand['tipo'] !== null && $n->tipo === $cand['tipo']) {
            return 'igual';
        }

        return null;
    }

    /* CNPJ igual quando os dois têm; senão razão social igual (um recibo lido
       por OCR pode ter só o nome, e a nota antiga só o CNPJ). */
    private function mesmoFornecedor(Nota $n, array $cand): bool
    {
        $cnpjDaNota = self::cnpjValido($n->cnpj);
        if ($cnpjDaNota !== '' && $cand['cnpj'] !== '') {
            return $cnpjDaNota === $cand['cnpj'];
        }

        return $cand['razao'] !== '' && $cand['razao'] === self::razaoNormalizada($n->razao_social);
    }

    /** CNPJ só com dígitos; vazio e "00000000000000" não são CNPJ. */
    private static function cnpjValido(?string $v): string
    {
        $c = preg_replace('/\D/', '', (string) $v);

        return (strlen($c) === 14 && ! preg_match('/^0+$/', $c)) ? $c : '';
    }

    private static function razaoNormalizada(?string $v): string
    {
        return preg_replace('/\s+/', ' ', mb_strtoupper(trim((string) $v)));
    }

    private static function numeroNormalizado(?string $v): string
    {
        return ltrim(trim((string) $v), '0');
    }

    /**
     * POST /notas/{id}/foto (multipart: file, ext?, user_id?, sem_colaborador?) → {foto_path}
     *
     * A nota pode ainda NÃO existir: o app sobe o anexo primeiro e grava a
     * nota depois (o upsert exige o arquivo no disco). Nesse caso o dono vem
     * em user_id (padrão: quem está logado) e o arquivo fica esperando em
     * <user_id>/<id>.<ext>; o upsert acha por arquivoDaNota().
     *
     * sem_colaborador=1 (28/09/2026): Faturamento sem dono — só gestor/admin,
     * e o arquivo vai pra pasta Nota::PASTA_GERAL em vez de <user_id>/.
     */
    public function foto(Request $r, string $id): JsonResponse
    {
        abort_unless(preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i', $id), 422, 'Id da nota inválido');
        $u = $r->user();
        $r->validate([
            'file' => ['required', 'file', 'max:'.config('petermann.foto_max_kb')],
            'ext' => ['nullable', 'string', 'max:5'],
            'user_id' => ['nullable', 'string', 'size:36', Rule::exists('colaboradores', 'id')],
            'sem_colaborador' => ['nullable', 'boolean'],
        ]);

        $nota = Nota::find($id);
        $semColaborador = $nota ? $nota->user_id === null : $r->boolean('sem_colaborador');
        if ($semColaborador) {
            abort_unless($u->gerencia(), 403, 'Só gestor ou admin lança Faturamento sem colaborador.');
            $pasta = Nota::PASTA_GERAL;
        } else {
            $pasta = $nota ? $nota->user_id : ($r->input('user_id') ?: $u->id);
            $this->podeGravar($u, $pasta, $nota !== null);
        }

        $path = $this->fotos->salvarPara($pasta, $id, $r->file('file'), $r->input('ext'));
        try {
            $this->fotos->miniatura($path);   // pronta para a tela Arquivos; se falhar, gera depois
        } catch (\Throwable) {
        }
        if ($nota) {
            $nota->foto_path = $path;
            $nota->updated_by = $u->id;
            $nota->save();
            /* anexo trocado: mede de novo (foto em branco que o colaborador acabou de corrigir deixa de ser pendência).
               Nota que ainda não existe é medida no upsert, quando nasce. */
            $this->fotoBranca->avaliar($nota, $u, refazer: true);
        }

        return response()->json(['foto_path' => $path, 'updated_at' => $nota?->updated_at]);
    }

    /**
     * POST /notas/reparar-fotos
     * Reconecta notas do usuário que perderam o foto_path mas cujo arquivo
     * continua no disco (caminho determinístico user_id/nota_id.ext). Só
     * religa referência: não apaga nem sobe nada.
     */
    public function repararFotos(Request $r): JsonResponse
    {
        $u = $r->user();
        $orfas = Nota::query()->where('user_id', $u->id)
            ->where('deleted', false)->whereNull('foto_path')->get();

        $recuperadas = [];
        foreach ($orfas as $n) {
            $arq = $this->fotos->arquivoDaNota($u->id, $n->id);
            if (! $arq) {
                continue;
            }
            $n->foto_path = $arq;
            $n->save();
            $recuperadas[] = ['id' => $n->id, 'foto_path' => $arq];
        }

        return response()->json(['recuperadas' => count($recuperadas), 'notas' => $recuperadas]);
    }

    /* $donoId nula só acontece em nota de Faturamento sem colaborador
       (28/09/2026) — nesse caso só passa quem gerencia (a validação já
       garante isso, aqui é a segunda trava do lado do servidor). */
    /* `notaExiste`: o Contador só mexe em nota que já existe (corrigir); para ele
       lançar nota nova continua 403. Quem vê a nota ser de outro é problema do
       upsert, que prende o dono. */
    private function podeGravar(Colaborador $u, ?string $donoId, bool $notaExiste = false): void
    {
        if ($u->soLeitura()) {
            abort_unless($notaExiste, 403, 'Contabilidade corrige notas que já existem; não lança nota nova');

            return;
        }
        abort_unless($donoId === $u->id || $u->gerencia(), 403, 'Sem permissão para esta nota');
    }
}
