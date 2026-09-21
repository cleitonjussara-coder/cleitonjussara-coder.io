<?php

namespace App\Http\Controllers;

use App\Models\Colaborador;
use App\Models\Nota;
use App\Services\FotoStorage;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

/**
 * Notas de despesa. As regras de acesso são as policies do Supabase:
 *   ver      → dono, ou gestor/admin (todos os núcleos)
 *   gravar   → dono, ou gestor/admin
 *   apagar   → dono, ou admin (gestor NÃO: apagar sem volta o lançamento
 *              de outra pessoa é outro nível — ver migração 2026-09-10)
 */
class NotaController extends Controller
{
    public function __construct(private FotoStorage $fotos) {}

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
        foreach (['cnpj', 'chave_nfce'] as $campo) {
            if ($r->filled($campo)) {
                $r->merge([$campo => preg_replace('/\D/', '', (string) $r->input($campo)) ?: null]);
            }
        }
        $d = $r->validate([
            'user_id' => ['required', 'string', 'size:36', Rule::exists('colaboradores', 'id')],
            'tipo' => ['required', Rule::in(Nota::TIPOS)],
            'subtipo' => ['nullable', Rule::in(Nota::SUBTIPOS)],
            'cnpj' => ['nullable', 'string', 'max:14'],
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
            'numero' => ['nullable', 'string', 'max:20'],
            'serie' => ['nullable', 'string', 'max:5'],
            'foto_path' => ['nullable', 'string', 'max:255'],
            'qr_url' => ['nullable', 'string'],
            'observacao' => ['nullable', 'string'],
            'deleted' => ['nullable', 'boolean'],
            'created_at' => ['nullable', 'date'],
        ]);

        $this->podeGravar($u, $d['user_id']);

        $nota = Nota::find($id);
        if ($nota) {
            $this->podeGravar($u, $nota->user_id);
        }

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
            $arquivo = $this->fotos->arquivoDaNota($d['user_id'], $id);
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

        return response()->json($nota->fresh());
    }

    /** DELETE /notas/{id} — definitivo: arquivo + linha. */
    public function destroy(Request $r, string $id): JsonResponse
    {
        $u = $r->user();
        $nota = Nota::findOrFail($id);
        abort_unless($nota->user_id === $u->id || $u->ehAdmin(), 403, 'Só o dono ou o admin apagam em definitivo');

        $this->fotos->apagarTodasVersoes($nota);
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
     * POST /notas/{id}/foto (multipart: file, ext?, user_id?) → {foto_path}
     *
     * A nota pode ainda NÃO existir: o app sobe o anexo primeiro e grava a
     * nota depois (o upsert exige o arquivo no disco). Nesse caso o dono vem
     * em user_id (padrão: quem está logado) e o arquivo fica esperando em
     * <user_id>/<id>.<ext>; o upsert acha por arquivoDaNota().
     */
    public function foto(Request $r, string $id): JsonResponse
    {
        abort_unless(preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i', $id), 422, 'Id da nota inválido');
        $u = $r->user();
        $r->validate([
            'file' => ['required', 'file', 'max:'.config('petermann.foto_max_kb')],
            'ext' => ['nullable', 'string', 'max:5'],
            'user_id' => ['nullable', 'string', 'size:36', Rule::exists('colaboradores', 'id')],
        ]);

        $nota = Nota::find($id);
        $dono = $nota ? $nota->user_id : ($r->input('user_id') ?: $u->id);
        $this->podeGravar($u, $dono);

        $path = $this->fotos->salvarPara($dono, $id, $r->file('file'), $r->input('ext'));
        try {
            $this->fotos->miniatura($path);   // pronta para a tela Arquivos; se falhar, gera depois
        } catch (\Throwable) {
        }
        if ($nota) {
            $nota->foto_path = $path;
            $nota->updated_by = $u->id;
            $nota->save();
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

    private function podeGravar(Colaborador $u, string $donoId): void
    {
        abort_unless($donoId === $u->id || $u->veTudo(), 403, 'Sem permissão para esta nota');
    }
}
