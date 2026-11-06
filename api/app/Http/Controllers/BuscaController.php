<?php

namespace App\Http\Controllers;

use App\Models\Colaborador;
use App\Models\Nota;
use App\Models\Repasse;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Collection;
use Illuminate\Support\Str;

/**
 * Busca geral do app (06/11/2026, pedido do Cleiton). Só leitura.
 * Quem decide o que aparece é visiveisPara, o mesmo escopo de GET /notas e GET /repasses:
 * colaborador acha só o que é dele; gestor, admin e Contador acham o da equipe.
 * Vários termos se somam: "ana posto" é nota da Ana num posto.
 */
class BuscaController extends Controller
{
    private const LIMITE_NOTAS = 30;

    private const LIMITE_REPASSES = 15;

    private const LIMITE_PESSOAS = 8;

    private const MAX_TERMOS = 6;

    private const ATALHOS = ['sem_foto', 'sem_valor', 'hoje', 'faturamento', 'pedidos'];

    /** GET /busca?q=texto ou GET /busca?atalho=sem_foto */
    public function index(Request $r): JsonResponse
    {
        $u = $r->user();
        $pessoas = $u->veTudo() ? Colaborador::query()->get(['id', 'nome', 'email', 'role', 'regime', 'ativo']) : collect();

        $atalho = (string) $r->query('atalho', '');
        if (in_array($atalho, self::ATALHOS, true)) {
            return $this->atalho($atalho, $u, $pessoas);
        }

        $texto = trim((string) $r->query('q', ''));
        if (mb_strlen($texto) < 2) {
            return $this->resposta(collect(), 0, collect(), 0, collect(), $pessoas);
        }
        $termos = array_slice(array_values(array_filter(preg_split('/[[:space:]]+/u', $texto))), 0, self::MAX_TERMOS);

        $notas = Nota::query()->visiveisPara($u)->where('deleted', false);
        $repasses = Repasse::query()->visiveisPara($u)->where('deleted', false);
        foreach ($termos as $t) {
            $ids = $this->idsDaPessoa($t, $pessoas);
            $notas->where(fn (Builder $w) => $this->notaTemTermo($w, $t, $ids));
            $repasses->where(fn (Builder $w) => $this->repasseTemTermo($w, $t, $ids));
        }

        $achadas = $pessoas->filter(function ($c) use ($termos) {
            $alvo = $this->normal($c->nome.' '.$c->email);

            return collect($termos)->every(fn ($t) => str_contains($alvo, $this->normal($t)));
        })->sortBy('nome')->take(self::LIMITE_PESSOAS)->values();

        return $this->resposta(...$this->listar($notas, $repasses), ...[$achadas, $pessoas]);
    }

    private function atalho(string $atalho, Colaborador $u, Collection $pessoas): JsonResponse
    {
        $notas = Nota::query()->visiveisPara($u)->where('deleted', false);
        $repasses = Repasse::query()->visiveisPara($u)->where('deleted', false);
        $agora = now('America/Sao_Paulo');

        if ($atalho === 'pedidos') {
            $repasses->whereIn('kind', ['requested', 'request', 'pedido', 'solicitado'])->whereNull('atendido_em');
            $notas->whereRaw('1 = 0');
        } else {
            $repasses->whereRaw('1 = 0');
            match ($atalho) {
                'sem_foto' => $notas->where(fn (Builder $w) => $w->whereNull('foto_path')->orWhere('foto_path', '')),
                'sem_valor' => $notas->where(fn (Builder $w) => $w->whereNull('valor')->orWhere('valor', '<=', 0)),
                'hoje' => $notas->whereDate('data', $agora->toDateString()),
                'faturamento' => $notas->where('pagamento', 'empresa')->where('ano', $agora->year)->where('mes', $agora->month),
            };
        }

        return $this->resposta(...$this->listar($notas, $repasses), ...[collect(), $pessoas]);
    }

    /** @return array{0: Collection, 1: int, 2: Collection, 3: int} */
    private function listar(Builder $notas, Builder $repasses): array
    {
        return [
            (clone $notas)->orderByDesc('data')->orderByDesc('created_at')->limit(self::LIMITE_NOTAS)->get(),
            (clone $notas)->count(),
            (clone $repasses)->orderByDesc('data')->orderByDesc('created_at')->limit(self::LIMITE_REPASSES)->get(),
            (clone $repasses)->count(),
        ];
    }

    private function resposta(Collection $notas, int $totalNotas, Collection $repasses, int $totalRepasses, Collection $achadas, Collection $pessoas): JsonResponse
    {
        $nomes = $pessoas->pluck('nome', 'id');
        $comNome = fn ($x) => [...$x->toArray(), 'user_nome' => $nomes[$x->user_id] ?? null];

        return response()->json([
            'notas' => $notas->map($comNome)->values(),
            'total_notas' => $totalNotas,
            'repasses' => $repasses->map($comNome)->values(),
            'total_repasses' => $totalRepasses,
            'pessoas' => $achadas,
        ]);
    }

    /** @param  array<int, string>  $ids */
    private function notaTemTermo(Builder $w, string $t, array $ids): void
    {
        foreach (['razao_social', 'numero', 'placa', 'observacao'] as $coluna) {
            $this->contem($w, $coluna, $t);
        }
        /* Só CNPJ ou número digitado com pontuação vira dígitos. "1.234,56" e a placa ABC1D23 achariam CNPJ que só contém esses dígitos. */
        $digitos = preg_replace('/[^0-9]/', '', $t);
        $ehDinheiro = str_contains($t, ',') || preg_match('/^[0-9]+[.][0-9]{1,2}$/', $t);
        if (strlen($digitos) >= 3 && ! $ehDinheiro && ! preg_match('/[[:alpha:]]/u', $t)) {
            $this->contem($w, 'cnpj', $digitos);
            $this->contem($w, 'numero', $digitos);
        }
        $alvo = $this->normal($t);
        $subtipos = array_values(array_filter(Nota::SUBTIPOS, fn ($s) => str_contains($this->normal($s), $alvo)));
        if ($subtipos) {
            $w->orWhereIn('subtipo', $subtipos);
        }
        if (str_contains('alimentacao', $alvo)) {
            $w->orWhere('tipo', 'RDA');
        }
        $this->valorOuPessoa($w, $t, $ids);
    }

    /** @param  array<int, string>  $ids */
    private function repasseTemTermo(Builder $w, string $t, array $ids): void
    {
        $this->contem($w, 'descricao', $t);
        $w->orWhere('tipo', mb_strtoupper($t));
        $this->valorOuPessoa($w, $t, $ids);
    }

    /** @param  array<int, string>  $ids */
    private function valorOuPessoa(Builder $w, string $t, array $ids): void
    {
        $valor = $this->valorDe($t);
        if ($valor !== null) {
            $w->orWhereBetween('valor', [$valor - 0.005, $valor + 0.005]);
        }
        if ($ids) {
            $w->orWhereIn('user_id', $ids);
        }
    }

    /** LIKE do termo como foi digitado e sem acento: o fornecedor costuma vir em maiúsculas e sem acento da nota. */
    private function contem(Builder $w, string $coluna, string $t): void
    {
        foreach (array_unique([$t, Str::ascii($t)]) as $variante) {
            $escapado = str_replace(['!', '%', '_'], ['!!', '!%', '!_'], $variante);
            $w->orWhereRaw("{$coluna} LIKE ? ESCAPE '!'", ['%'.$escapado.'%']);
        }
    }

    /** "284,90", "1.234,56", "R$ 50", "284.90" e "284" viram número; o resto não é valor. */
    private function valorDe(string $t): ?float
    {
        $s = str_ireplace('r$', '', $t);
        if (preg_match('/^[0-9]{1,3}([.][0-9]{3})*(,[0-9]{1,2})?$/', $s) || preg_match('/^[0-9]+,[0-9]{1,2}$/', $s)) {
            return (float) str_replace(',', '.', str_replace('.', '', $s));
        }

        return preg_match('/^[0-9]+([.][0-9]{1,2})?$/', $s) ? (float) $s : null;
    }

    /** @return array<int, string> */
    private function idsDaPessoa(string $t, Collection $pessoas): array
    {
        $alvo = $this->normal($t);

        return mb_strlen($alvo) < 2 ? [] : $pessoas->filter(fn ($c) => str_contains($this->normal((string) $c->nome), $alvo))->pluck('id')->all();
    }

    private function normal(string $s): string
    {
        return mb_strtolower(Str::ascii($s));
    }
}
