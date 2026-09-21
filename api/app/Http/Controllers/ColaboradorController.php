<?php

namespace App\Http\Controllers;

use App\Models\Colaborador;
use App\Models\KmRegistro;
use App\Models\Nota;
use App\Models\Ponto;
use App\Models\Repasse;
use App\Models\Veiculo;
use App\Services\FotoStorage;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Validation\Rule;

/**
 * Colaboradores. Além de listar/editar (papel, núcleo), desde 20/09/2026:
 *   • desativar/reativar (gestor ou admin) — a pessoa não entra mais e some
 *     das listas, mas o histórico dela fica;
 *   • excluir de vez — apaga TUDO (notas, anexos, repasses, km, pontos,
 *     foto de perfil, tokens) e exige DUAS pessoas: um gestor/admin pede,
 *     OUTRO gestor/admin confirma. Ninguém exclui a si mesmo.
 */
class ColaboradorController extends Controller
{
    public function __construct(private FotoStorage $fotos) {}

    /** GET /colaboradores[?todos=1] — sem `todos`, só os ativos. */
    public function index(Request $r): JsonResponse
    {
        $u = $r->user();
        $q = Colaborador::query()->orderBy('nome');
        if (! $u->veTudo()) {
            $q->whereKey($u->id);
        } elseif (! $r->boolean('todos')) {
            $q->where('ativo', true);
        }

        return response()->json($q->get()->map(fn ($c) => $this->comPedido($c)));
    }

    public function show(Request $r, string $id): JsonResponse
    {
        $u = $r->user();
        abort_unless($id === $u->id || $u->veTudo(), 403);

        return response()->json($this->comPedido(Colaborador::findOrFail($id)));
    }

    public function update(Request $r, string $id): JsonResponse
    {
        $u = $r->user();
        $alvo = Colaborador::findOrFail($id);
        abort_unless($id === $u->id || $u->ehAdmin(), 403, 'Só o admin edita outros perfis');

        $d = $r->validate([
            'nome' => ['sometimes', 'string', 'max:120'],
            'role' => ['sometimes', Rule::in(Colaborador::ROLES)],
            'nucleo' => ['sometimes', 'string', 'max:60'],
        ]);
        if (! $u->ehAdmin()) {
            unset($d['role'], $d['nucleo']);      // colaborador não se promove
        }
        if (isset($d['nome'])) {
            $d['nome'] = trim($d['nome']);
        }
        $alvo->update($d);

        return response()->json($this->comPedido($alvo->fresh()));
    }

    /** PATCH /colaboradores/{id}/ativo {ativo: bool} — gestor ou admin, nunca em si mesmo. */
    public function ativo(Request $r, string $id): JsonResponse
    {
        $u = $r->user();
        abort_unless($u->gerencia(), 403, 'Só gestor ou admin desativa colaborador');
        abort_if($id === $u->id, 422, 'Você não pode desativar a si mesmo');
        $alvo = Colaborador::findOrFail($id);
        $d = $r->validate(['ativo' => ['required', 'boolean']]);

        $alvo->forceFill(['ativo' => $d['ativo'], 'desativado_em' => $d['ativo'] ? null : now()])->save();
        if (! $d['ativo']) {
            $alvo->tokens()->delete();   // derruba as sessões abertas nos aparelhos
        }
        Log::info('colaborador '.($d['ativo'] ? 'reativado' : 'desativado'), ['alvo' => $alvo->email, 'por' => $u->email]);

        return response()->json($this->comPedido($alvo->fresh()));
    }

    /**
     * POST /colaboradores/{id}/excluir
     * 1ª chamada (gestor/admin): registra o pedido → {status:'aguardando'}.
     * 2ª chamada por OUTRO gestor/admin: apaga tudo → {status:'excluido', …}.
     * Quem pediu pode chamar de novo, mas não confirma o próprio pedido.
     */
    public function excluir(Request $r, string $id): JsonResponse
    {
        $u = $r->user();
        abort_unless($u->gerencia(), 403, 'Só gestor ou admin exclui colaborador');
        abort_if($id === $u->id, 422, 'Você não pode excluir a si mesmo');
        $alvo = Colaborador::findOrFail($id);
        /* sem digitar e-mail (pedido do usuário 20/09): a proteção é a
           2ª pessoa, não a digitação */

        if (! $alvo->exclusao_pedida_por) {
            $alvo->forceFill(['exclusao_pedida_por' => $u->id, 'exclusao_pedida_em' => now()])->save();
            Log::info('exclusão de colaborador PEDIDA', ['alvo' => $alvo->email, 'por' => $u->email]);

            return response()->json(['status' => 'aguardando', 'colaborador' => $this->comPedido($alvo->fresh())]);
        }
        if ($alvo->exclusao_pedida_por === $u->id) {
            return response()->json(['status' => 'aguardando', 'colaborador' => $this->comPedido($alvo), 'mensagem' => 'Você já pediu. Outro gestor ou admin precisa confirmar.']);
        }

        /* segunda pessoa: executa */
        $contagem = DB::transaction(function () use ($alvo) {
            $notas = Nota::where('user_id', $alvo->id)->get();
            foreach ($notas as $n) {
                $this->fotos->apagarTodasVersoes($n);
            }
            $c = [
                'notas' => Nota::where('user_id', $alvo->id)->delete(),
                'repasses' => Repasse::where('user_id', $alvo->id)->delete(),
                'km' => KmRegistro::where('user_id', $alvo->id)->delete(),
                'pontos' => Ponto::where('user_id', $alvo->id)->delete(),
            ];
            Veiculo::where('responsavel_id', $alvo->id)->update(['responsavel_id' => null]);
            $alvo->tokens()->delete();
            $alvo->delete();

            return $c;
        });
        /* pasta inteira do colaborador (perfil, km-*.jpg, miniaturas) */
        try {
            $this->fotos->disk()->deleteDirectory($alvo->id);
        } catch (\Throwable $e) {
            Log::warning('exclusão: pasta de fotos não apagada: '.$e->getMessage());
        }
        Log::warning('colaborador EXCLUÍDO', ['alvo' => $alvo->email, 'pedido_por' => $alvo->exclusao_pedida_por, 'confirmado_por' => $u->email] + $contagem);

        return response()->json(['status' => 'excluido'] + $contagem);
    }

    /** DELETE /colaboradores/{id}/excluir — cancela um pedido pendente (gestor/admin). */
    public function cancelarExclusao(Request $r, string $id): JsonResponse
    {
        $u = $r->user();
        abort_unless($u->gerencia(), 403);
        $alvo = Colaborador::findOrFail($id);
        $alvo->forceFill(['exclusao_pedida_por' => null, 'exclusao_pedida_em' => null])->save();
        Log::info('exclusão de colaborador CANCELADA', ['alvo' => $alvo->email, 'por' => $u->email]);

        return response()->json($this->comPedido($alvo->fresh()));
    }

    /** JSON do colaborador + nome de quem pediu a exclusão (para a tela). */
    private function comPedido(Colaborador $c): array
    {
        $a = $c->toArray();
        $a['exclusao_pedida_por_nome'] = $c->exclusao_pedida_por
            ? (Colaborador::find($c->exclusao_pedida_por)?->nome ?? '(removido)') : null;

        return $a;
    }
}
