<?php

namespace App\Http\Controllers;

use App\Models\Colaborador;
use App\Models\Nota;
use App\Models\NotaHistorico;
use App\Services\DuplicataNota;
use App\Services\FechamentoMes;
use App\Services\FotoEmBrancoAviso;
use App\Services\FotoStorage;
use App\Services\HistoricoNota;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Arr;
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
    public function __construct(private FotoStorage $fotos, private FotoEmBrancoAviso $fotoBranca, private HistoricoNota $historico, private FechamentoMes $fechamento, private DuplicataNota $duplicata) {}

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
        /* 03/11/2026: nota apagada em definitivo não renasce pela fila de um aparelho. Vem antes da validação: item velho
           com corpo recusável também precisa ouvir que a nota acabou, senão fica preso tomando 422. */
        if ($this->apagadaEmDefinitivo($id)) {
            return $this->respostaApagada();
        }
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
            'placa' => ['nullable', 'string', 'max:10', 'regex:/^[A-Za-z0-9]+$/'],   // recibo de pedágio (27/10/2026)
            'hora' => ['nullable', 'string', 'regex:/^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$/'],   // hora do recibo de pedágio (09/11/2026)
            'portal_nfse' => ['nullable', 'string', 'max:300'],   // normalizado em upsert(); link ruim vira null, sem travar a fila
            'foto_path' => ['nullable', 'string', 'max:255'],
            'qr_url' => ['nullable', 'string'],
            'observacao' => ['nullable', 'string'],
            'deleted' => ['nullable', 'boolean'],
            'created_at' => ['nullable', 'date'],
        ]);
        /* 03/11/2026: o caminho do anexo nunca vem do cliente. Ele só nasce de arquivoDaNota() (nota nova) e de foto(); aceitar
           o que chega aqui gerava URL assinada para arquivo de outra pessoa e gravava "../../.env". A regra acima fica frouxa
           de propósito: aparelho antigo segue mandando o campo e não pode tomar 422 por isso. */
        unset($d['foto_path']);

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
        /* Fechamento de mês (06/11/2026): vale para todos, gestor inclusive, e também quando a data nova entra num mês fechado.
           Vem depois das permissões (quem não pode mexer ouve 403 de qualquer jeito) e ANTES do 409. Os dois não gravam nada e
           devolvem a nota; a diferença é o que a pessoa faz depois. O 409 diz "refaça em cima da versão nova", e ela refaria só
           para tomar 423. O 423 diz o que continua valendo: nada muda até reabrir. Também antes da trava de Faturamento, pelo
           motivo do 409 abaixo. Reenvio idêntico responde 200 sem gravar: nada mudou, e a fila não pode prender por isso.
           Anexo diferente em espera é mudança mesmo com os campos iguais: com 200, o aparelho apagaria o arquivo sem aviso, e a
           espera entraria na nota com a próxima edição, depois de reabrir. Por isso ela sai aqui nos dois caminhos (ver foto()).
           Só a espera de quem não é da gestão, que é de quem ela seria: o PUT do gestor não decide pelo anexo do colaborador. */
        if ($nota && ($periodo = $this->fechamento->periodoTravado($nota, $d['data']))) {
            $pasta = $this->fotos->pastaDe($nota);
            $espera = $u->veTudo() ? null : $this->fotos->conteudoDaEspera($pasta, $id);
            if ($espera !== null) {
                $this->fotos->descartarEspera($pasta, $id);
            }
            $anexoNovo = $espera !== null && $espera !== $this->conteudoDoAnexo($nota->foto_path);
            if (! $anexoNovo && $this->reenvioIdentico($nota, $d)) {
                return response()->json($nota);
            }

            return $this->fechamento->recusa($nota, $periodo, $u);
        }
        /* 03/11/2026: a correção da gestão vence. O aparelho diz em cima de qual versão editou; se a gestão mexeu depois, nada
           é gravado e ele recebe a nota atual. Fica ANTES da trava de Faturamento: a nota que a gestão virou Faturamento
           daria 403 no colaborador e o item ficaria recusado para sempre; nos dois casos nada é gravado. */
        if ($nota && $this->gestaoMexeuDepois($nota, $u, $r->input('base_updated_at'))) {
            Log::warning('edição descartada: a gestão corrigiu a nota depois', [
                'id' => $id, 'enviado_por' => $u->email,
                'descartado' => Arr::only($d, ['valor', 'tipo', 'subtipo', 'data', 'razao_social', 'deleted']),
                'anexo_descartado' => $this->fotos->descartarEspera($this->fotos->pastaDe($nota), $id),
            ]);

            return response()->json([
                'message' => 'A gestão corrigiu esta nota depois da sua edição. Vale a versão corrigida.',
                'conflito' => true,
                'nota' => $nota,
            ], 409);
        }
        /* 25/09/2026: nota de Faturamento (paga direto pela empresa, exclui do
           saldo/cartão de quem for escolhido) só gestor ou admin lança —
           mesma regra vale editando uma nota já existente.
           03/11/2026: olhava só o pagamento novo, e colaborador e contador
           trocavam 'empresa' por 'carteira' com 200. Vale para o atual também. */
        $mexeNoFaturamento = in_array('empresa', [$d['pagamento'] ?? null, $nota?->pagamento], true);
        abort_if($mexeNoFaturamento && ! $u->gerencia(), 403, 'Só gestor ou admin lança nota de Faturamento.');

        $d['metodo_captura'] = $d['metodo_captura'] ?? 'manual';
        $d['deleted'] = (bool) ($d['deleted'] ?? false);

        /* placa do recibo de pedágio: maiúscula; e, até a migração rodar, nem tenta gravar (senão TODA nota quebra com "no such column") */
        if (array_key_exists('placa', $d)) {
            $d['placa'] = $d['placa'] === null ? null : strtoupper($d['placa']);
            if (! Nota::temPlaca()) {
                unset($d['placa']);
            }
        }

        /* hora do recibo de pedágio (09/11/2026): mesma proteção da placa até a migração rodar */
        if (! Nota::temHora()) {
            unset($d['hora']);
        }

        /* link da NFS-e do pedágio: se o recibo não trouxe, usa o último já lido dessa concessionária (mesmo CNPJ) */
        if (! Nota::temPortalNfse()) {
            unset($d['portal_nfse']);
        } else {
            if (array_key_exists('portal_nfse', $d)) {
                $d['portal_nfse'] = Nota::portalNormalizado($d['portal_nfse']);
            }
            /* null enviado é campo apagado: não pode cair no valor antigo */
            $cnpj = (string) (array_key_exists('cnpj', $d) ? $d['cnpj'] : $nota?->cnpj);
            $documento = array_key_exists('documento', $d) ? $d['documento'] : $nota?->documento;
            if (($d['portal_nfse'] ?? $nota?->portal_nfse) === null && $documento === 'outro'
                && strlen($cnpj) === 14 && trim($cnpj, '0') !== '') {
                $jaLido = Nota::where('cnpj', $cnpj)->where('id', '!=', $id)->where('deleted', false)
                    ->whereNotNull('portal_nfse')->orderByDesc('updated_at')->value('portal_nfse');
                if ($jaLido !== null) {
                    $d['portal_nfse'] = $jaLido;
                }
            }
        }

        $anexoTrocado = false;
        /* 08/11/2026: nota que ENTRA agora (nova, ou tirada da lixeira) é conferida contra a equipe; ver o aviso abaixo */
        $entrando = $nota ? ($nota->deleted && ! $d['deleted']) : ! $d['deleted'];
        if ($nota) {
            unset($d['created_at']);
            $donoAntes = $nota->user_id;
            $retrato = $this->historico->retrato($nota);   // 06/11/2026: o histórico compara com isto depois de salvar
            $nota->fill($d);
            $nota->updated_by = $u->id;
            /* 04/11/2026: a pasta decide quem abre o anexo, então ele acompanha a nota. Só gestor/admin chega aqui com dono
               diferente (podeGravar e a trava do Contador acima); o caminho sai do banco e do disco, nunca do corpo do PUT. */
            $mudanca = $nota->user_id !== $donoAntes ? $this->levarAnexo($nota, $donoAntes, $u) : null;
            /* 03/11/2026: edição aceita traz junto o anexo que esperava por ela (ver foto()). Só quem não é da gestão guarda
               anexo em espera, então um PUT da gestão não pode fazer entrar o arquivo do colaborador. A espera de um dono
               anterior não passa por aqui: a troca a guarda em outra pasta (04/11/2026). */
            $temEspera = ! $u->veTudo() && $this->fotos->temEspera($this->fotos->pastaDe($nota), $id);
            /* 06/11/2026: lido antes, porque a promoção sobrescreve o atual. O mesmo arquivo reenviado continua sendo promovido,
               mas não é troca (ver foto()). Só com espera: ler o anexo em todo PUT seria custo à toa. */
            $conteudoAntes = $temEspera ? $this->conteudoDoAnexo($nota->foto_path) : null;
            $emEspera = $temEspera ? $this->fotos->promoverEspera($this->fotos->pastaDe($nota), $id) : null;
            if ($emEspera !== null) {
                $nota->foto_path = $emEspera;
                $anexoTrocado = ! $this->mesmoConteudo($conteudoAntes, $emEspera);
            }
            try {
                $nota->save();
            } catch (\Throwable $e) {
                if ($mudanca) {
                    $this->fotos->desfazerMudanca($mudanca);   // a nota ficou como estava: a origem segue valendo
                }
                throw $e;
            }
            $this->historico->registrarMudanca($retrato, $nota, $u, $anexoTrocado);
            if ($mudanca) {
                $this->fotos->concluirMudanca($mudanca);
            }
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
            /* 06/11/2026: nota nova de mês fechado ENTRA, nunca é recusada: quem estava em campo sem sinal não pode perder o
               lançamento. Fica marcada para a gestão conferir. A que nasce na lixeira não muda a planilha, então não é marcada. */
            $foraDoFechamento = ! $d['deleted'] && Nota::temForaFechamento() && $this->fechamento->dataFechada($d['data']);
            if ($foraDoFechamento) {
                $nota->fora_fechamento_em = now();
            }
            $nota->save();
            $this->historico->registrarCriacao($nota, $u);
            if ($foraDoFechamento) {
                $this->fechamento->notaEntrouFora($nota, $u);
            }
        }

        /* Foto em branco (21/10/2026): mede o anexo se ainda não foi medido (nota nova, ou antiga que acabou de ser
           editada). Só marca e avisa a gestão; nunca recusa nem apaga, e erro aqui nunca derruba o envio. */
        $this->fotoBranca->avaliar($nota, $u, refazer: $anexoTrocado);

        /* Nota duplicada (08/11/2026): o app só pergunta "Lançar assim mesmo?" e a nota entra. Quando ela repete outra nota
           viva da equipe, gestor e admin recebem push. Só na entrada (reenvio da fila ou edição não avisam de novo); nunca
           recusa nem apaga, e erro aqui nunca derruba o envio. */
        if ($entrando) {
            $this->duplicata->avisarSeDuplicada($nota, $u);
        }

        return response()->json($nota->fresh());
    }

    /* 04/11/2026: se o arquivo não chega ao destino, nada da edição é gravado: dono e anexo novos pela metade deixariam o
       comprovante numa pasta que o dono não abre. 503 é o que a fila do app trata como falha passageira e tenta de novo. */
    private function levarAnexo(Nota $nota, ?string $donoAntes, Colaborador $u): array
    {
        try {
            $mudanca = $this->fotos->levarParaPasta(
                $nota->id, $nota->foto_path, $donoAntes ?? Nota::PASTA_GERAL, $this->fotos->pastaDe($nota),
            );
        } catch (\Throwable $e) {
            Log::warning('troca de dono recusada: anexo não foi movido', [
                'nota' => $nota->id, 'de' => $donoAntes, 'para' => $nota->user_id, 'por' => $u->email, 'erro' => $e->getMessage(),
            ]);
            abort(503, 'Não deu para mover o anexo para a pasta do novo dono. Nada foi alterado: a nota segue com o dono e o comprovante de antes. Tente de novo.');
        }
        $nota->foto_path = $mudanca['foto_path'];

        return $mudanca;
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
        if ($periodo = $this->fechamento->periodoTravado($nota)) {
            return $this->fechamento->recusa($nota, $periodo, $u);   // 06/11/2026
        }

        $retrato = $this->historico->retrato($nota);
        $nota->forceFill(['tipo' => $tipo, 'subtipo' => $subtipo, 'updated_by' => $u->id])->save();
        $this->historico->registrarMudanca($retrato, $nota, $u);
        Log::warning('nota corrigida pelo gestor', [
            'nota' => $nota->id, 'de' => $antes,
            'para' => $tipo.($subtipo ? ' · '.$subtipo : ''),
            'por' => $u->email, 'dono' => $nota->user_id,
        ]);

        return response()->json(['nota' => $nota->fresh(), 'mudou' => true]);
    }

    /**
     * PATCH /notas/{id}/lixeira {deleted} — gestor/admin manda a nota para a lixeira (ou a traz de volta) direto no
     * servidor (30/10/2026). Existe para a pasta Faturamento, onde a nota pode ser de qualquer pessoa ou de ninguém e
     * não está no aparelho de quem a corrige. Não apaga em definitivo: o dono/gestor ainda a vê em Apagados.
     */
    public function lixeira(Request $r, string $id): JsonResponse
    {
        $u = $r->user();
        abort_unless($u->gerencia(), 403, 'Só gestor ou admin mandam a nota para a lixeira');
        $d = $r->validate(['deleted' => ['required', 'boolean']]);

        $nota = Nota::findOrFail($id);
        if ((bool) $nota->deleted !== (bool) $d['deleted']) {
            if ($periodo = $this->fechamento->periodoTravado($nota)) {
                return $this->fechamento->recusa($nota, $periodo, $u);   // 06/11/2026: sair ou voltar da lixeira muda a planilha
            }
            $retrato = $this->historico->retrato($nota);
            $nota->forceFill(['deleted' => (bool) $d['deleted'], 'updated_by' => $u->id])->save();
            $this->historico->registrarMudanca($retrato, $nota, $u);
            Log::warning('nota '.($d['deleted'] ? 'enviada para a lixeira' : 'restaurada').' pelo servidor', [
                'nota' => $nota->id, 'por' => $u->email, 'dono' => $nota->user_id, 'pagamento' => $nota->pagamento,
            ]);
        }

        return response()->json(['nota' => $nota->fresh()]);
    }

    /**
     * GET /notas/{id}/historico → {disponivel, registros:[…]} (06/11/2026, pedido do dono): quem mudou o quê, do mais novo
     * para o mais velho, limite de 200. Vê quem vê a nota (dono, gestor, admin, contabilidade). Para os demais a resposta é
     * sempre o mesmo 404, exista a nota ou não. Nota apagada de vez: só quem tem veTudo(), porque o dono já não a tem.
     */
    public function historico(Request $r, string $id): JsonResponse
    {
        $u = $r->user();
        $nota = Nota::find($id);
        abort_unless($u->veTudo() || ($nota && $nota->user_id === $u->id), 404, 'Nota não encontrada');

        /* API publicada antes da migração: a tela diz que o histórico ainda não está ativo, sem erro */
        if (! NotaHistorico::tabelaExiste()) {
            return response()->json(['disponivel' => false, 'registros' => []]);
        }
        $registros = $this->historico->listar($id);
        abort_if(! $nota && $registros === [] && ! DB::table('notas_apagadas')->where('id', $id)->exists(), 404, 'Nota não encontrada');

        return response()->json(['disponivel' => true, 'registros' => $registros]);
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
               das 21:57 de 16/10 — e a ordenava como texto, fora de lugar. Agora sai em ISO UTC, como o resto.
               04/11/2026: excluir um colaborador grava uma lápide por nota com o mesmo carimbo, e 500 linhas de uma só exclusão
               escondiam os apagamentos antigos. O limite agora conta GRUPOS (dono, quem apagou, instante). Lápide única sai como
               antes, com o id dela; no grupo o id é só um representante, para app antigo seguir lendo a mesma forma. */
            $grupos = $q->selectRaw('MIN(id) AS id, user_id, apagada_por, apagada_em, COUNT(*) AS quantidade')
                ->groupBy('user_id', 'apagada_por', 'apagada_em')
                ->orderByDesc('apagada_em')->limit(500)->get();
            $exclusoes = $this->exclusoesDeColaborador($grupos);

            return response()->json(
                $grupos->map(function ($l) use ($exclusoes) {
                    $l->quantidade = (int) $l->quantidade;
                    $l->colaborador_excluido = $l->user_id !== null && ($exclusoes[$l->user_id] ?? null) === $l->apagada_em;
                    $l->apagada_em = $l->apagada_em ? \Carbon\Carbon::parse($l->apagada_em, 'UTC')->toISOString() : null;

                    return $l;
                })->values()
            );
        }

        return response()->json($q->orderBy('apagada_em')->limit(5000)->pluck('id'));
    }

    /* 04/11/2026: a lápide não diz por que a nota foi apagada, e vários apagamentos no mesmo segundo também formam grupo. Mas
       quem foi excluído não tem mais nota nenhuma: a última lápide de um dono que sumiu é a da exclusão. Falha só se ele
       foi excluído sem nota nenhuma e já tinha apagamento antes, e aí a última lápide leva o rótulo. Devolve dono => carimbo. */
    private function exclusoesDeColaborador(\Illuminate\Support\Collection $grupos): array
    {
        $donos = $grupos->pluck('user_id')->filter()->unique();
        $sumiram = $donos->diff(Colaborador::whereIn('id', $donos->all())->pluck('id'));

        return DB::table('notas_apagadas')->whereIn('user_id', $sumiram->all())
            ->selectRaw('user_id, MAX(apagada_em) AS ultima')->groupBy('user_id')
            ->pluck('ultima', 'user_id')->all();
    }

    public function destroy(Request $r, string $id): JsonResponse
    {
        $u = $r->user();
        $nota = Nota::findOrFail($id);
        abort_unless($nota->user_id === $u->id || $u->gerencia(), 403, 'Só o dono, o gestor ou o admin apagam em definitivo');

        /* 06/11/2026: antes do 409, pelo mesmo motivo do upsert: a nota sair da lixeira não resolveria nada, o mês é que manda */
        if ($periodo = $this->fechamento->periodoTravado($nota)) {
            return $this->fechamento->recusa($nota, $periodo, $u);
        }

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
        $retrato = $this->historico->retrato($nota);
        $nota->delete();
        /* 06/11/2026: o histórico da nota fica, sem chave estrangeira: é a prova de quem apagou */
        $this->historico->registrarExclusao($retrato, $id, $u);

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
     * POST /notas/duplicada {chave?, qr_url?, tipo?, cnpj?, razao_social?, valor?, data?, numero?, serie?, subtipo?, hora?, ignore_id?}
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
            'subtipo' => ['nullable', 'string', 'max:40'],
            'hora' => ['nullable', 'string', 'max:8'],
            'ignore_id' => ['nullable', 'string', 'size:36'],
        ]);
        $u = $r->user();

        [$achada, $motivo] = $this->duplicata->achar($d, $d['ignore_id'] ?? null) ?? [null, null];

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
        /* 03/11/2026: anexo de nota apagada em definitivo ficaria órfão no disco; o upsert seguinte nem a deixa nascer */
        if ($this->apagadaEmDefinitivo($id)) {
            return $this->respostaApagada();
        }
        $r->validate([
            'file' => ['required', 'file', 'max:'.config('petermann.foto_max_kb')],
            'ext' => ['nullable', 'string', 'max:5'],
            'user_id' => ['nullable', 'string', 'size:36', Rule::exists('colaboradores', 'id')],
            'sem_colaborador' => ['nullable', 'boolean'],
            'data' => ['nullable', 'string', 'max:10'],
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

        /* 06/11/2026: o anexo é comprovante da planilha entregue, então trocar é alterar. Nota que ainda não existe nem chega aqui:
           o anexo dela sobe antes do PUT, e nota nova nunca é recusada. O mesmo arquivo de novo (resposta perdida) não troca nada.
           `data` é a data da edição que este anexo acompanha: sem ela, a nota de mês aberto movida para um mês fechado gravava o
           anexo aqui, salvarPara apagava o comprovante e só o PUT tomava 423. App anterior não manda e segue como antes. */
        if ($nota && ($periodo = $this->fechamento->periodoTravado($nota, $r->input('data')))) {
            if ($this->conteudoDoAnexo($nota->foto_path) === sha1_file($r->file('file')->getRealPath())) {
                return response()->json(['foto_path' => $nota->foto_path, 'updated_at' => $nota->updated_at]);
            }

            return $this->fechamento->recusa($nota, $periodo, $u);
        }

        /* 03/11/2026: o app sobe o anexo ANTES da nota, e só o PUT diz de qual versão a edição veio. Em nota que a gestão
           corrigiu por último, gravar aqui apagaria o anexo dela mesmo com o PUT tomando 409, sem rastro. O arquivo espera
           o PUT; a nota não muda de autor nem de hora, e não há nada para os outros aparelhos puxarem até ele ser aceito. */
        if ($nota && $this->ultimaEdicaoFoiDaGestao($nota, $u)) {
            $path = $this->fotos->guardarEmEspera($pasta, $id, $r->file('file'), $r->input('ext'));
            Log::warning('anexo em espera: a gestão foi a última a mexer na nota', ['id' => $id, 'enviado_por' => $u->email]);

            return response()->json(['foto_path' => $path, 'updated_at' => $nota->updated_at]);
        }

        /* 06/11/2026: precisa ser antes de gravar, porque salvarPara sobrescreve o arquivo que serve de comparação */
        $conteudoAntes = $nota ? $this->conteudoDoAnexo($nota->foto_path) : null;
        $path = $this->fotos->salvarPara($pasta, $id, $r->file('file'), $r->input('ext'));
        try {
            $this->fotos->miniatura($path);   // pronta para a tela Arquivos; se falhar, gera depois
        } catch (\Throwable) {
        }
        if ($nota) {
            $nota->foto_path = $path;
            $nota->updated_by = $u->id;
            $nota->save();
            if (! $this->mesmoConteudo($conteudoAntes, $path)) {
                $this->historico->registrarAnexo($id, $u);
            }
            /* anexo trocado: mede de novo (foto em branco que o colaborador acabou de corrigir deixa de ser pendência).
               Nota que ainda não existe é medida no upsert, quando nasce. */
            $this->fotoBranca->avaliar($nota, $u, refazer: true);
        }

        return response()->json(['foto_path' => $path, 'updated_at' => $nota?->updated_at]);
    }

    /* A fila repete o envio quando a resposta se perde: o mesmo arquivo de novo não é troca de anexo (06/11/2026). A conta é
       entre o guardado antes e o guardado depois, nunca com os bytes enviados: o servidor regrava o JPEG com rotação no EXIF, e
       o reenvio dele não bateria com o que já está no disco. Na dúvida (null), conta como troca: é o que o histórico mostra. */
    private function conteudoDoAnexo(?string $path): ?string
    {
        try {
            return $path !== null && $this->fotos->existe($path) ? sha1((string) $this->fotos->disk()->get($path)) : null;
        } catch (\Throwable) {
            return null;
        }
    }

    private function mesmoConteudo(?string $antes, string $path): bool
    {
        return $antes !== null && $antes === $this->conteudoDoAnexo($path);
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
            $n->timestamps = ! $this->ultimaEdicaoFoiDaGestao($n, $u);   // 03/11/2026: subir a hora sem assinar viraria falso conflito em quem já conhecia a correção
            $n->save();
            $this->historico->registrarAnexo($n->id, $u, 'anexo religado');   // 06/11/2026: a nota mudou, mas o arquivo é o mesmo de antes
            $recuperadas[] = ['id' => $n->id, 'foto_path' => $arq];
        }

        return response()->json(['recuperadas' => count($recuperadas), 'notas' => $recuperadas]);
    }

    /* O aparelho reenviou o que o servidor já tem (resposta perdida, item velho na fila)? Compara só o que veio no corpo, com a
       mesma limpeza da gravação. metodo_captura fica de fora: é técnico, não vai à planilha, e o padrão 'manual' daria falso
       "mudou". portal_nfse nulo também: o servidor pode ter preenchido pelo CNPJ, e o aparelho antigo nunca soube. */
    private function reenvioIdentico(Nota $nota, array $d): bool
    {
        $texto = fn (mixed $v): ?string => ($s = trim((string) $v)) === '' ? null : $s;
        $campos = ['user_id', 'tipo', 'subtipo', 'pagamento', 'consumidor', 'razao_social', 'chave_nfce', 'uf', 'modelo', 'documento', 'numero', 'serie', 'qr_url', 'observacao'];
        foreach ($campos as $c) {
            if (array_key_exists($c, $d) && $texto($d[$c]) !== $texto($nota->{$c})) {
                return false;
            }
        }
        $cnpj = fn (mixed $v): string => ltrim((string) preg_replace('/\D/', '', (string) $v), '0');   // 14 zeros é o vazio do app antigo
        if (array_key_exists('cnpj', $d) && $cnpj($d['cnpj']) !== $cnpj($nota->cnpj)) {
            return false;
        }
        if (Nota::temPlaca() && array_key_exists('placa', $d) && strtoupper((string) $d['placa']) !== strtoupper((string) $nota->placa)) {
            return false;
        }
        if (Nota::temHora() && array_key_exists('hora', $d) && (string) $d['hora'] !== (string) $nota->hora) {
            return false;
        }
        if (Nota::temPortalNfse() && ($portal = Nota::portalNormalizado($d['portal_nfse'] ?? null)) !== null && $portal !== $nota->portal_nfse) {
            return false;
        }

        return abs((float) $d['valor'] - (float) $nota->valor) < 0.005
            && $d['data'] === $nota->data?->format('Y-m-d')
            && (bool) ($d['deleted'] ?? false) === (bool) $nota->deleted;
    }

    /* Tem lápide e não está na tabela. Nota com lápide que segue na tabela renasceu antes de 03/11/2026: está viva e continua editável. */
    private function apagadaEmDefinitivo(string $id): bool
    {
        return DB::table('notas_apagadas')->where('id', $id)->exists() && ! Nota::whereKey($id)->exists();
    }

    private function respostaApagada(): JsonResponse
    {
        return response()->json(['message' => 'Esta nota foi apagada em definitivo.', 'apagada' => true], 410);
    }

    /* A última mão na nota foi de gestor, admin ou contabilidade, e quem chega agora não é da gestão (03/11/2026). */
    private function ultimaEdicaoFoiDaGestao(Nota $nota, Colaborador $u): bool
    {
        if ($u->veTudo() || $nota->updated_by === null || $nota->updated_by === $u->id) {
            return false;
        }

        return (bool) Colaborador::find($nota->updated_by)?->veTudo();
    }

    /* base_updated_at: o updated_at do servidor que o aparelho conhecia ao editar. Sem base (app antigo) ou com base
       inválida, nunca é conflito: segue a última gravação. Compara instantes em segundos: o app manda milissegundos e o
       banco guarda segundos. Só aceita data ISO porque o Carbon também entende "yesterday" e "0". */
    private function gestaoMexeuDepois(Nota $nota, Colaborador $u, mixed $base): bool
    {
        if (! is_string($base) || ! preg_match('/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/', $base)) {
            return false;
        }
        try {
            $conhecida = \Carbon\Carbon::parse($base)->utc();
        } catch (\Throwable) {
            return false;
        }

        return $nota->updated_at?->getTimestamp() > $conhecida->getTimestamp() && $this->ultimaEdicaoFoiDaGestao($nota, $u);
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
