<?php

namespace App\Http\Controllers;

use App\Models\Repasse;
use App\Services\RepasseEmailService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

/**
 * Repasses (PIX / transferências recebidas e solicitações).
 *   ver     → dono, ou gestor/admin
 *   inserir → só o dono
 *   editar  → dono, ou admin
 */
class RepasseController extends Controller
{
    public function __construct(private RepasseEmailService $email) {}

    public function index(Request $r): JsonResponse
    {
        $u = $r->user();
        $q = Repasse::query()->visiveisPara($u);

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
        $q->orderByDesc('data')->orderByDesc('created_at');

        return response()->json($q->get());
    }

    /** PUT /repasses/{id} — upsert. Dispara o e-mail de solicitação se for o caso. */
    public function upsert(Request $r, string $id): JsonResponse
    {
        $u = $r->user();
        $d = $r->validate([
            'user_id' => ['required', 'string', 'size:36', Rule::exists('colaboradores', 'id')],
            'tipo' => ['required', Rule::in(['RDA', 'RDM'])],
            'valor' => ['required', 'numeric', 'min:0'],
            'data' => ['required', 'date_format:Y-m-d'],
            'mes' => ['required', 'integer', 'between:1,12'],
            'ano' => ['required', 'integer', 'min:2020'],
            'descricao' => ['nullable', 'string'],
            'kind' => ['nullable', Rule::in(Repasse::KINDS)],
            'deleted' => ['nullable', 'boolean'],
            'created_at' => ['nullable', 'date'],
        ]);
        $d['kind'] = $d['kind'] ?? 'received';
        $d['deleted'] = (bool) ($d['deleted'] ?? false);

        $rep = Repasse::find($id);
        if ($rep) {
            abort_unless($rep->user_id === $u->id || $u->ehAdmin(), 403, 'Sem permissão para este repasse');
            unset($d['created_at']);
            $rep->fill($d)->save();
        } else {
            abort_unless($d['user_id'] === $u->id, 403, 'Repasse só pode ser lançado pelo próprio colaborador');
            $rep = new Repasse(['id' => $id] + $d);
            $rep->save();
        }

        /* Depois de gravado — falha de e-mail nunca impede o registro. */
        $this->email->enviarSePreciso($rep);

        return response()->json($rep->fresh());
    }
}
