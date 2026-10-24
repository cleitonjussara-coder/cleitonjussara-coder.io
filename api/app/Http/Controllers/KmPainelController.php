<?php

namespace App\Http\Controllers;

use App\Models\Colaborador;
use App\Models\KmRegistro;
use App\Models\Veiculo;
use App\Services\KmCalculo;
use Carbon\Carbon;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\Rule;

/**
 * Histórico e painel de acompanhamento do KM (pedido do Cleiton, 21/10/2026).
 *
 *   GET /frota/historico → leituras em ordem cronológica, com o km rodado desde a
 *                          leitura anterior do mesmo veículo, filtros e total;
 *                          `tudo=1` = desde a primeira leitura (22/10/2026)
 *   GET /frota/painel    → km por dia/semana/mês, comparação com o período
 *                          anterior, série para o gráfico e ranking
 *
 * Quem vê o quê: gestor/admin veem tudo (e o ranking); o colaborador vê só as
 * leituras e os números dele — mas o km de cada leitura dele é calculado sobre
 * a leitura anterior do VEÍCULO, de quem for, senão carro compartilhado
 * daria km errado. O Contador não usa a Frota (middleware SomenteLeitura).
 */
class KmPainelController extends Controller
{
    /* ── Histórico ─────────────────────────────────────────── */
    public function historico(Request $r): JsonResponse
    {
        $u = $r->user();
        $d = $r->validate([
            'de' => ['nullable', 'date_format:Y-m-d'],
            'ate' => ['nullable', 'date_format:Y-m-d'],
            'user_id' => ['nullable', 'string', 'size:36'],
            'veiculo_id' => ['nullable', 'string', 'size:36'],
            'limite' => ['nullable', 'integer', 'min:1', 'max:200'],
            'offset' => ['nullable', 'integer', 'min:0'],
            'tudo' => ['nullable', 'boolean'],
        ]);
        /* "Todo o histórico" (22/10/2026): da primeira leitura que existe até hoje (ou até a última, se alguma antiga
           tiver ficado à frente); de/ate são ignorados. A página continua sendo `limite` — o app carrega por partes. */
        $tudo = (bool) ($d['tudo'] ?? false);
        if ($tudo) {
            $ext = DB::table('km_registros')->where('deleted', false)->selectRaw('min(data) as ini, max(data) as fim')->first();
            $ate = max(KmCalculo::hoje(), substr((string) ($ext->fim ?? ''), 0, 10));
            $de = $ext->ini ? substr((string) $ext->ini, 0, 10) : $ate;
        } else {
            $ate = $d['ate'] ?? KmCalculo::hoje();
            $de = $d['de'] ?? KmCalculo::periodo('mes', $ate)['ini'];
        }
        if ($de > $ate) {
            return response()->json(['message' => 'A data inicial é depois da final.'], 422);
        }
        $limite = (int) ($d['limite'] ?? 50);
        $offset = (int) ($d['offset'] ?? 0);

        $todas = $this->leituras($de, $ate, true)['leituras'];
        $visiveis = array_values(array_filter($todas, fn ($l) => $this->visivel($u, $l)));

        /* os filtros do colaborador comum não enxergam os outros: user_id só vale para gestor/admin */
        $lista = array_values(array_filter($visiveis, fn ($l) => (! $u->veTudo() || empty($d['user_id']) || $l['user_id'] === $d['user_id'])
            && (empty($d['veiculo_id']) || $l['veiculo_id'] === $d['veiculo_id'])));
        usort($lista, fn ($a, $b) => [$b['data'], $b['odometro'], (string) $b['criado'], $b['id']] <=> [$a['data'], $a['odometro'], (string) $a['criado'], $a['id']]);

        $nomes = Colaborador::query()->pluck('nome', 'id');
        $veiculos = Veiculo::query()->orderBy('placa')->get(['id', 'placa', 'modelo', 'ativo'])->keyBy('id');

        $itens = array_map(fn ($l) => $this->itemJson($u, $l, $nomes, $veiculos), array_slice($lista, $offset, $limite));

        return response()->json([
            /* no histórico inteiro, "de" é a leitura mais antiga do que a pessoa vê com esses filtros (o "desde" da tela) */
            'de' => $tudo ? ($lista ? end($lista)['data'] : $ate) : $de, 'ate' => $ate, 'tudo' => $tudo,
            'total' => count($lista), 'total_km' => array_sum(array_column($lista, 'km')),
            /* km de cada dia do filtro inteiro: o cabeçalho do dia não pode depender de quanto já foi carregado */
            'por_dia' => $this->kmPorDia($lista),
            'tem_mais' => $offset + $limite < count($lista),
            'itens' => $itens,
            /* opções dos filtros: só o que existe no período (sem aplicar os filtros) */
            'colaboradores' => $u->veTudo()
                ? collect($visiveis)->pluck('user_id')->unique()->map(fn ($id) => ['id' => $id, 'nome' => $nomes[$id] ?? '?'])->sortBy('nome')->values()
                : [],
            'veiculos' => $veiculos->filter(fn ($v) => $v->ativo || in_array($v->id, array_column($visiveis, 'veiculo_id'), true))
                ->map(fn ($v) => ['id' => $v->id, 'placa' => $v->placa, 'modelo' => $v->modelo])->values(),
        ]);
    }

    /** @return array<string,int>|object  objeto vazio (e não []) para o JSON sair como {} */
    private function kmPorDia(array $lista): array|object
    {
        $dias = [];
        foreach ($lista as $l) {
            $dias[$l['data']] = ($dias[$l['data']] ?? 0) + $l['km'];
        }

        return $dias === [] ? (object) [] : $dias;
    }

    private function itemJson(Colaborador $u, array $l, $nomes, $veiculos): array
    {
        $v = $veiculos[$l['veiculo_id']] ?? null;
        $ant = $l['anterior'];
        $registrado = $l['criado'];
        $editadoEm = null;
        if (! empty($l['atualizado_por'])) {
            $editadoEm = $l['updated_at'];
        } elseif ($l['updated_at'] && $l['created_at'] && Carbon::parse($l['updated_at'], 'UTC')->diffInSeconds(Carbon::parse($l['created_at'], 'UTC'), true) > 120) {
            $editadoEm = $l['updated_at'];
        }

        return [
            'id' => $l['id'], 'veiculo_id' => $l['veiculo_id'], 'placa' => $v?->placa, 'modelo' => $v?->modelo,
            'user_id' => $l['user_id'], 'user_nome' => $nomes[$l['user_id']] ?? '?',
            'data' => $l['data'], 'odometro' => $l['odometro'],
            'registrado_em' => $registrado ? Carbon::parse($registrado, 'UTC')->toISOString() : null,
            'km_rodado' => $l['km'], 'alerta' => $l['alerta'],
            'anterior_odometro' => $ant['odometro'] ?? null, 'anterior_data' => $ant['data'] ?? null,
            'anterior_em' => isset($ant['criado']) ? Carbon::parse($ant['criado'], 'UTC')->toISOString() : null,
            /* o nome de quem fez a leitura anterior é do gestor: o colaborador comum não vê o dos outros */
            'anterior_por' => $u->veTudo() && $ant ? ($nomes[$ant['user_id']] ?? '?') : null,
            'observacao' => $l['observacao'], 'foto_path' => $l['foto_path'],
            'editado_em' => $editadoEm ? Carbon::parse($editadoEm, 'UTC')->toISOString() : null,
            'editado_por' => ! empty($l['atualizado_por']) ? ($nomes[$l['atualizado_por']] ?? null) : null,
            'pode_editar' => $this->podeMexer($u, $l['user_id']),
        ];
    }

    /** Mesma regra do FrotaController: o dono, e gestor/admin (21/10/2026). */
    private function podeMexer(Colaborador $u, string $donoId): bool
    {
        return $donoId === $u->id || $u->gerencia();
    }

    private function visivel(Colaborador $u, array $l): bool
    {
        return $u->veTudo() || $l['user_id'] === $u->id;
    }

    /* ── Painel ────────────────────────────────────────────── */
    public function painel(Request $r): JsonResponse
    {
        $u = $r->user();
        $d = $r->validate([
            'modo' => ['nullable', Rule::in(KmCalculo::MODOS)],
            'ref' => ['nullable', 'date_format:Y-m-d'],
            'ate' => ['nullable', 'date_format:Y-m-d'],
        ]);
        $hoje = KmCalculo::hoje();
        $modo = $d['modo'] ?? 'semana';
        $ref = $d['ref'] ?? $hoje;
        $per = KmCalculo::periodo($modo, $ref);
        $ant = KmCalculo::anterior($modo, $ref);

        /* a barra selecionada tem que estar dentro do gráfico: se não estiver, o gráfico termina nela */
        $serie = KmCalculo::serie($modo, $d['ate'] ?? $ref);
        if ($per['ini'] < $serie[0]['ini'] || $per['fim'] > $serie[count($serie) - 1]['fim']) {
            $serie = KmCalculo::serie($modo, $ref);
        }
        /* contexto do colaborador ("na semana", "no mês"): o mês é o do INÍCIO do período mostrado — o mesmo que a tela rotula.
           (Com `ref` seria o mês do último dia: semana de 26/10 a 01/11 abriria novembro.) */
        $ctx = ['dia' => KmCalculo::periodo('dia', $ref), 'semana' => KmCalculo::periodo('semana', $ref), 'mes' => KmCalculo::periodo('mes', $per['ini'])];

        $ini = min($serie[0]['ini'], $ant['ini'], $ctx['semana']['ini'], $ctx['mes']['ini']);
        $fim = max($serie[count($serie) - 1]['fim'], $per['fim'], $ctx['semana']['fim'], $ctx['mes']['fim']);
        $carga = $this->leituras($ini, $fim);
        $vis = array_values(array_filter($carga['leituras'], fn ($l) => $this->visivel($u, $l)));

        $atual = $per['ini'] <= $hoje && $hoje <= $per['fim'];
        $dias = $hoje < $per['ini'] ? 0 : (int) ((strtotime(min($hoje, $per['fim'])) - strtotime($per['ini'])) / 86400) + 1;
        /* semana/mês em andamento: compara com os MESMOS dias do período anterior, não com ele inteiro */
        $cmp = $atual && $modo !== 'dia' ? KmCalculo::comparavel($ant, $dias) : $ant;

        $tot = KmCalculo::somar($vis, $per);
        $totAnt = KmCalculo::somar($vis, $cmp);

        $nomes = Colaborador::query()->get(['id', 'nome', 'ativo'])->keyBy('id');
        $veiculos = Veiculo::query()->orderBy('placa')->get(['id', 'placa', 'modelo', 'ativo']);
        /* "X de Y": o X só conta veículo ativo (Y é o total de ativos); o colaborador, sem Y, conta os que ele usou */
        $idsContados = $u->veTudo() ? $veiculos->where('ativo', true)->pluck('id')->all() : $veiculos->pluck('id')->all();
        $veiculosRodaram = count(array_unique(array_column(array_filter($vis, fn ($l) => $l['km'] > 0 && $l['data'] >= $per['ini'] && $l['data'] <= $per['fim'] && in_array($l['veiculo_id'], $idsContados, true)), 'veiculo_id')));

        $porVeiculo = [];
        foreach ($veiculos as $v) {
            $minhas = array_values(array_filter($vis, fn ($l) => $l['veiculo_id'] === $v->id));
            $a = KmCalculo::somar($minhas, $per);
            $b = KmCalculo::somar($minhas, $cmp);
            if (! $u->veTudo() && ! $a['leituras'] && ! $b['leituras']) {
                continue;
            }
            if (! $v->ativo && ! $a['leituras'] && ! $b['leituras']) {
                continue;
            }
            /* "última leitura" = a última até o FIM do período mostrado (não até onde a janela de dados foi carregada) */
            $ateOFim = array_values(array_filter($minhas, fn ($l) => $l['data'] <= $per['fim']));
            $ult = $ateOFim ? end($ateOFim) : ($carga['bases'][$v->id] ?? null);
            $porVeiculo[] = [
                'veiculo_id' => $v->id, 'placa' => $v->placa, 'modelo' => $v->modelo,
                'km' => $a['km'], 'km_anterior' => $b['km'], 'leituras' => $a['leituras'],
                'ultimo_odometro' => $ult['odometro'] ?? null, 'ultima_data' => $ult['data'] ?? null,
            ];
        }
        usort($porVeiculo, fn ($a, $b) => [$b['km'], $b['km_anterior'], $a['placa']] <=> [$a['km'], $a['km_anterior'], $b['placa']]);

        /* ranking de gente é do gestor/admin; o colaborador comum só tem os números dele */
        $porPessoa = null;
        if ($u->veTudo()) {
            $porPessoa = [];
            foreach (collect($vis)->groupBy('user_id') as $id => $ls) {
                $ls = $ls->all();
                $c = $nomes[$id] ?? null;
                $a = KmCalculo::somar($ls, $per);
                $b = KmCalculo::somar($ls, $cmp);
                if ($c && ! $c->ativo && ! $a['leituras'] && ! $b['leituras']) {
                    continue;
                }
                $porPessoa[] = [
                    'user_id' => $id, 'nome' => $c?->nome ?? '?', 'km' => $a['km'], 'km_anterior' => $b['km'], 'leituras' => $a['leituras'],
                    'ultima_data' => collect($ls)->where('data', '<=', $per['fim'])->max('data'),
                ];
            }
            usort($porPessoa, fn ($a, $b) => [$b['km'], $b['km_anterior'], $a['nome']] <=> [$a['km'], $a['km_anterior'], $b['nome']]);
        }

        return response()->json([
            'modo' => $modo, 'ref' => $ref, 'hoje' => $hoje,
            'periodo' => $per + ['atual' => $atual],
            'anterior' => $ant, 'comparado_com' => $cmp, 'comparacao_parcial' => $cmp !== $ant,
            'total' => $tot['km'], 'total_anterior' => $totAnt['km'], 'variacao_pct' => KmCalculo::variacao($tot['km'], $totAnt['km']),
            'leituras' => $tot['leituras'], 'dias_decorridos' => $dias,
            'veiculos_rodaram' => $veiculosRodaram, 'veiculos_ativos' => $u->veTudo() ? $veiculos->where('ativo', true)->count() : null,
            'contexto' => [
                'dia' => KmCalculo::somar($vis, $ctx['dia']) + $ctx['dia'],
                'semana' => KmCalculo::somar($vis, $ctx['semana']) + $ctx['semana'],
                'mes' => KmCalculo::somar($vis, $ctx['mes']) + $ctx['mes'],      // com ini/fim: a tela rotula pelo mês de onde o número saiu
            ],
            'serie' => array_map(fn ($p) => $p + KmCalculo::somar($vis, $p), $serie),
            'colaboradores' => $porPessoa,
            'veiculos' => $porVeiculo,
        ]);
    }

    /* ── Leituras do período, com o km já calculado ────────── */
    /**
     * Todas as leituras (de todos) entre $ini e $fim com `km`, `anterior` e
     * `alerta`; `bases` = última leitura de cada veículo ANTES de $ini (parte
     * dela o km da primeira leitura da janela). Quem filtra por pessoa faz
     * depois — o km de uma leitura depende do veículo, não de quem olha.
     *
     * @return array{leituras: array<int,array>, bases: array<string,array>}
     */
    private function leituras(string $ini, string $fim, bool $completo = false): array
    {
        $cols = ['id', 'veiculo_id', 'user_id', 'data', 'odometro', 'created_at'];
        if (KmRegistro::temAuditoria()) {
            $cols[] = 'registrado_em';                      // é a hora que ordena e que o histórico mostra
        }
        if ($completo) {
            $cols = array_merge($cols, ['observacao', 'foto_path', 'updated_at']);
            if (KmRegistro::temAuditoria()) {
                $cols[] = 'atualizado_por';
            }
        }
        $linhas = DB::table('km_registros')->where('deleted', false)
            ->where('data', '>=', $ini)->where('data', '<=', $fim.' 23:59:59')
            ->get($cols)->map(fn ($x) => $this->linha((array) $x))->all();

        /* última leitura de cada veículo antes da janela: dela parte o km da primeira leitura da janela */
        $bases = array_map(fn ($b) => $this->linha($b), KmRegistro::ultimasPorVeiculo($ini));

        $saida = [];
        foreach (collect($linhas)->groupBy('veiculo_id') as $vid => $ls) {
            array_push($saida, ...KmCalculo::comKm($ls->all(), $bases[$vid] ?? null));
        }

        return ['leituras' => $saida, 'bases' => $bases];
    }

    private function linha(array $x): array
    {
        $x['data'] = substr((string) $x['data'], 0, 10);
        $x['odometro'] = (int) $x['odometro'];
        /* "criado" = a hora da leitura: a que o aparelho informou, ou a em que o registro subiu (registros antigos) */
        $x['criado'] = $x['registrado_em'] ?? $x['created_at'] ?? null;

        return $x + ['observacao' => null, 'foto_path' => null, 'updated_at' => null, 'registrado_em' => null, 'atualizado_por' => null];
    }
}
