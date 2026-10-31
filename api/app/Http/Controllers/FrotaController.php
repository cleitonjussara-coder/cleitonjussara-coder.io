<?php

namespace App\Http\Controllers;

use App\Models\Colaborador;
use App\Models\KmRegistro;
use App\Models\Veiculo;
use App\Services\FotoStorage;
use App\Services\KmCalculo;
use App\Services\LeitorOdometro;
use Carbon\Carbon;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;

/**
 * Frota: veículos e registros de quilometragem.
 *   veículos  → todos veem os ativos; gestor/admin cadastram e editam
 *   km        → dono lança e edita os seus; gestor/admin veem tudo e também corrigem
 *               ou excluem o de qualquer um (21/10/2026; antes só o admin)
 *   resumo    → km rodado por veículo no mês (o que a gestão da frota usa)
 *   histórico e painel de acompanhamento: KmPainelController
 */
class FrotaController extends Controller
{
    public function __construct(private FotoStorage $fotos) {}

    /* ── Veículos ──────────────────────────────────────────── */
    public function veiculos(Request $r): JsonResponse
    {
        $u = $r->user();
        $q = Veiculo::query()->with('responsavel:id,nome')->orderBy('placa');
        if (! ($u->veTudo() && $r->query('todos') === '1')) {
            $q->where('ativo', true);
        }

        /* a última leitura de cada veículo vai junto: o formulário de registro compara com ela,
           em qualquer mês, e o aparelho guarda para conferir sem internet */
        $ultimas = KmRegistro::ultimasPorVeiculo();

        return response()->json($q->get()->map(fn ($v) => $this->veiculoJson($v, $ultimas[$v->id] ?? null)));
    }

    public function veiculoUpsert(Request $r, string $id): JsonResponse
    {
        $u = $r->user();
        abort_unless($u->gerencia(), 403, 'Só gestor/admin cadastram veículos');
        $r->merge(['placa' => strtoupper(preg_replace('/[^A-Za-z0-9]/', '', (string) $r->input('placa')))]);
        $d = $r->validate([
            'placa' => ['required', 'string', 'min:7', 'max:10', Rule::unique('veiculos', 'placa')->ignore($id)],
            'modelo' => ['nullable', 'string', 'max:80'],
            'responsavel_id' => ['nullable', 'string', 'size:36', Rule::exists('colaboradores', 'id')],
            'ativo' => ['nullable', 'boolean'],
        ]);
        $d['ativo'] = (bool) ($d['ativo'] ?? true);
        $v = Veiculo::find($id);
        if (! $v) {
            if (! Str::isUuid($id)) {                    // o id vira texto em atributos HTML no app: só UUID
                return response()->json(['message' => 'Identificador do veículo inválido.'], 422);
            }
            $v = new Veiculo(['id' => $id]);
        }
        $v->fill($d)->save();

        return response()->json($this->veiculoJson($v->fresh('responsavel')));
    }

    private function veiculoJson(Veiculo $v, ?array $ultima = null): array
    {
        return [
            'id' => $v->id, 'placa' => $v->placa, 'modelo' => $v->modelo, 'ativo' => $v->ativo,
            'responsavel_id' => $v->responsavel_id, 'responsavel_nome' => $v->responsavel?->nome,
            'ultimo_odometro' => $ultima ? (int) $ultima['odometro'] : null,
            'ultima_data' => $ultima ? substr((string) $ultima['data'], 0, 10) : null,
        ];
    }

    /* ── Registros de KM ───────────────────────────────────── */
    public function index(Request $r): JsonResponse
    {
        $u = $r->user();
        $q = KmRegistro::query()->visiveisPara($u)->where('deleted', false)
            ->with(['veiculo:id,placa,modelo', 'colaborador:id,nome']);
        if ($r->filled('ano')) {
            $q->whereYear('data', (int) $r->query('ano'));
        }
        if ($r->filled('mes')) {
            $q->whereMonth('data', (int) $r->query('mes'));
        }
        if ($r->filled('veiculo_id')) {
            $q->where('veiculo_id', $r->query('veiculo_id'));
        }
        if ($r->filled('user_id')) {
            $q->where('user_id', $r->query('user_id'));
        }
        $q->orderByDesc('data')->orderByDesc('odometro');

        return response()->json($q->get()->map(fn ($k) => $this->kmJson($k)));
    }

    public function upsert(Request $r, string $id): JsonResponse
    {
        $u = $r->user();
        $d = $r->validate([
            'veiculo_id' => ['required', 'string', 'size:36', Rule::exists('veiculos', 'id')],
            'user_id' => ['nullable', 'string', 'size:36', Rule::exists('colaboradores', 'id')],
            'data' => ['required', 'date_format:Y-m-d'],
            'odometro' => ['required', 'integer', 'min:0', 'max:9999999'],
            'observacao' => ['nullable', 'string', 'max:500'],
            'registrado_em' => ['nullable', 'date'],
        ]);
        /* Nada gravado no futuro (mesma regra das notas): até 2 dias à frente é relógio de celular adiantado e vira hoje;
           mais que isso é erro de digitação — e uma leitura do ano 2999 viraria a "última leitura" do veículo para todo mundo. */
        $hoje = KmCalculo::hoje();
        if ($d['data'] > $hoje) {
            if ($d['data'] > date('Y-m-d', strtotime($hoje.' +2 days'))) {
                return response()->json(['message' => "A data está no futuro ({$d['data']}). A leitura registra algo que já aconteceu — corrija a data."], 422);
            }
            $d['data'] = $hoje;
        }
        $k = KmRegistro::find($id);
        if ($k) {
            abort_unless($this->podeMexer($u, $k), 403, 'Sem permissão para este registro');
            /* quem corrige não troca o dono da leitura nem a hora em que ela foi feita */
            unset($d['user_id'], $d['registrado_em']);
            /* "corrigido por" só quando foi outra pessoa; o dono mexendo no próprio registro limpa a marca */
            if (KmRegistro::temAuditoria()) {
                $d['atualizado_por'] = $k->user_id === $u->id ? null : $u->id;
            }
            $k->fill($d)->save();
            if ($k->user_id !== $u->id) {
                Log::info('km corrigido por outra pessoa', ['id' => $k->id, 'dono' => $k->user_id, 'por' => $u->id, 'odometro' => $k->odometro]);
            }
        } else {
            /* o id vira texto em atributos HTML no app: só UUID (o app sempre gera com crypto.randomUUID) */
            if (! Str::isUuid($id)) {
                return response()->json(['message' => 'Identificador do registro inválido.'], 422);
            }
            $d['registrado_em'] = KmRegistro::temAuditoria() ? $this->momento($d['registrado_em'] ?? null) : null;
            if ($d['registrado_em'] === null) {
                unset($d['registrado_em']);
            }
            $d['user_id'] = $d['user_id'] ?? $u->id;
            abort_unless($d['user_id'] === $u->id || $u->ehAdmin(), 403, 'Registro só pode ser lançado pelo próprio colaborador');
            /* leitura menor que a anterior do mesmo veículo é quase sempre erro de
               digitação — recusa com mensagem clara; correção passa por editar. */
            $ultimo = KmRegistro::where('veiculo_id', $d['veiculo_id'])->where('deleted', false)
                ->where('data', '<=', $d['data'])->orderByDesc('data')->orderByDesc('odometro')->first();
            if ($ultimo && $d['odometro'] < $ultimo->odometro) {
                return response()->json(['message' => "Odômetro menor que a última leitura deste veículo ({$ultimo->odometro} km em {$ultimo->data->format('d/m/Y')}). Confira o número."], 422);
            }
            $k = new KmRegistro(['id' => $id] + $d);
            $k->save();
        }

        return response()->json($this->kmJson($k->fresh(['veiculo', 'colaborador'])));
    }

    public function destroy(Request $r, string $id): JsonResponse
    {
        $u = $r->user();
        $k = KmRegistro::findOrFail($id);
        abort_unless($this->podeMexer($u, $k), 403, 'Sem permissão para este registro');
        if ($k->user_id !== $u->id) {
            Log::warning('km excluído por outra pessoa', ['id' => $k->id, 'dono' => $k->user_id, 'por' => $u->id, 'veiculo' => $k->veiculo_id, 'data' => $k->data->format('Y-m-d'), 'odometro' => $k->odometro]);
        }
        $this->fotos->apagarVersoesDe($k->user_id, 'km-'.$k->id);
        $k->delete();

        return response()->json(['ok' => true]);
    }

    /** O dono mexe no que é dele; gestor e admin corrigem o de qualquer um (21/10/2026). */
    private function podeMexer(Colaborador $u, KmRegistro $k): bool
    {
        return $k->user_id === $u->id || $u->gerencia();
    }

    /** Hora em que a leitura foi feita, no relógio do aparelho; sem ela ou no futuro, vale agora. UTC, "Y-m-d H:i:s". */
    private function momento(?string $informado): string
    {
        $agora = now();
        try {
            $m = $informado ? Carbon::parse($informado)->utc() : $agora;
        } catch (\Throwable) {
            $m = $agora;
        }

        return ($m->greaterThan($agora->copy()->addMinutes(10)) ? $agora : $m)->format('Y-m-d H:i:s');
    }

    /** POST /km/{id}/foto — foto do odômetro (opcional). */
    public function foto(Request $r, string $id): JsonResponse
    {
        $u = $r->user();
        $k = KmRegistro::findOrFail($id);
        abort_unless($this->podeMexer($u, $k), 403, 'Sem permissão para este registro');
        $r->validate(['file' => ['required', 'file', 'max:'.config('petermann.foto_max_kb')]]);
        $path = $this->fotos->salvarPara($k->user_id, 'km-'.$k->id, $r->file('file'), $r->input('ext'));
        $k->foto_path = $path;
        $k->save();

        return response()->json(['foto_path' => $path]);
    }

    /**
     * POST /km/ler-foto — IA de visão lê o odômetro do recorte da foto.
     * Só SUGERE o número (o app preenche o campo e pede conferência); nada é
     * gravado aqui. Limite diário por colaborador para segurar o gasto.
     */
    public function lerFoto(Request $r, LeitorOdometro $leitor): JsonResponse
    {
        $r->validate(['file' => ['required', 'file', 'mimetypes:image/jpeg,image/png,image/webp', 'max:4096']]);
        if (! $leitor->disponivel()) {
            return response()->json(['valor' => null, 'motivo' => 'indisponivel']);
        }

        $chave = 'odometro-ia:'.$r->user()->id.':'.now('America/Sao_Paulo')->format('Y-m-d');
        $limite = (int) config('petermann.anthropic.limite_dia');
        if ($limite > 0 && (int) Cache::get($chave, 0) >= $limite) {
            return response()->json(['valor' => null, 'motivo' => 'limite']);
        }
        Cache::add($chave, 0, now()->addDay());
        Cache::increment($chave);

        $arq = $r->file('file');
        $valor = $leitor->ler((string) file_get_contents($arq->getRealPath()), (string) $arq->getMimeType());

        return response()->json(['valor' => $valor, 'motivo' => $valor === null ? 'nao_leu' : null]);
    }

    private function kmJson(KmRegistro $k): array
    {
        return [
            'id' => $k->id, 'veiculo_id' => $k->veiculo_id, 'placa' => $k->veiculo?->placa, 'modelo' => $k->veiculo?->modelo,
            'user_id' => $k->user_id, 'user_nome' => $k->colaborador?->nome,
            'data' => $k->data->format('Y-m-d'), 'odometro' => $k->odometro,
            'observacao' => $k->observacao, 'foto_path' => $k->foto_path,
            'registrado_em' => KmRegistro::temAuditoria() ? $k->registrado_em?->toIso8601String() : null,
            'created_at' => $k->created_at?->toIso8601String(), 'updated_at' => $k->updated_at?->toIso8601String(),
        ];
    }

    /**
     * GET /frota/anual?ano → base da planilha e do dashboard.
     * Km de cada leitura = odômetro − leitura anterior do MESMO veículo
     * (inclusive a última do ano anterior); vai para o mês e o motorista
     * da leitura. Devolve veículo × mês, motorista × mês e as leituras.
     */
    public function anual(Request $r): JsonResponse
    {
        $u = $r->user();
        $ano = (int) $r->query('ano', now()->year);
        $ini = "{$ano}-01-01";
        $fim = "{$ano}-12-31";

        $veiculos = Veiculo::query()->with('responsavel:id,nome')->orderBy('placa')->get();
        $nomes = Colaborador::query()->pluck('nome', 'id');
        $porVeiculo = [];
        $porMotorista = [];
        $mesesTotal = array_fill(1, 12, 0);
        $leituras = [];

        foreach ($veiculos as $v) {
            /* A cadeia de leituras é a do VEÍCULO inteiro (de quem for): o km de uma leitura parte da anterior, mesmo que seja
               de outra pessoa. O colaborador só soma e lista as dele — igual ao painel e ao histórico (21/10/2026). */
            $base = KmRegistro::query()->where('deleted', false)->where('veiculo_id', $v->id);
            $antes = (clone $base)->where('data', '<', $ini)->orderByDesc('data')->orderByDesc('odometro')->first();
            $doAno = (clone $base)->whereBetween('data', [$ini, $fim])->orderBy('data')->orderBy('odometro')->get();
            $meus = fn (KmRegistro $k) => $u->veTudo() || $k->user_id === $u->id;
            $visiveis = $doAno->filter($meus)->values();
            if (! $visiveis->count() && ! $v->ativo) {
                continue;
            }
            $meses = array_fill(1, 12, 0);
            $prev = $antes?->odometro;
            foreach ($doAno as $k) {
                $delta = $prev === null ? 0 : max(0, $k->odometro - $prev);
                $odoAnterior = $prev;
                $prev = $k->odometro;
                if (! $meus($k)) {
                    continue;
                }
                $m = (int) $k->data->format('n');
                $meses[$m] += $delta;
                $mesesTotal[$m] += $delta;
                $mk = $k->user_id;
                $porMotorista[$mk] ??= ['user_id' => $mk, 'nome' => $nomes[$mk] ?? '?', 'meses' => array_fill(1, 12, 0), 'total' => 0, 'leituras' => 0];
                $porMotorista[$mk]['meses'][$m] += $delta;
                $porMotorista[$mk]['total'] += $delta;
                $porMotorista[$mk]['leituras']++;
                $leituras[] = [
                    'id' => $k->id, 'data' => $k->data->format('Y-m-d'), 'mes' => $m, 'placa' => $v->placa, 'modelo' => $v->modelo,
                    'user_id' => $mk, 'motorista' => $nomes[$mk] ?? '?', 'odometro' => $k->odometro, 'odometro_anterior' => $odoAnterior, 'km_rodado' => $delta,
                    'observacao' => $k->observacao, 'foto' => (bool) $k->foto_path,
                ];
            }
            $porVeiculo[] = [
                'veiculo_id' => $v->id, 'placa' => $v->placa, 'modelo' => $v->modelo, 'ativo' => $v->ativo,
                'responsavel_nome' => $v->responsavel?->nome,
                'meses' => array_values($meses), 'total' => array_sum($meses), 'leituras' => $visiveis->count(),
                'odometro_inicial' => $antes?->odometro ?? $visiveis->first()?->odometro, 'odometro_final' => $visiveis->last()?->odometro,
            ];
        }
        $motoristas = array_values(array_map(fn ($m) => ['user_id' => $m['user_id'], 'nome' => $m['nome'], 'meses' => array_values($m['meses']), 'total' => $m['total'], 'leituras' => $m['leituras']], $porMotorista));
        usort($motoristas, fn ($a, $b) => $b['total'] <=> $a['total']);
        usort($leituras, fn ($a, $b) => strcmp($b['data'], $a['data']) ?: $b['odometro'] <=> $a['odometro']);

        return response()->json([
            'ano' => $ano, 'veiculos' => $porVeiculo, 'motoristas' => $motoristas,
            'meses_total' => array_values($mesesTotal), 'total' => array_sum($mesesTotal), 'leituras' => $leituras,
        ]);
    }

    /**
     * GET /frota/resumo?ano&mes → por veículo: km rodado no mês, última
     * leitura, quem dirigiu. Km do mês = maior leitura do mês − leitura
     * imediatamente anterior ao mês (ou a menor do mês, se não houver).
     */
    public function resumo(Request $r): JsonResponse
    {
        $u = $r->user();
        $ano = (int) $r->query('ano', now()->year);
        $mes = (int) $r->query('mes', now()->month);
        $ini = sprintf('%04d-%02d-01', $ano, $mes);
        $fim = date('Y-m-t', strtotime($ini));

        $veiculos = Veiculo::query()->with('responsavel:id,nome')->where('ativo', true)->orderBy('placa')->get();
        $out = [];
        foreach ($veiculos as $v) {
            $base = KmRegistro::query()->visiveisPara($u)->where('deleted', false)->where('veiculo_id', $v->id);
            $doMes = (clone $base)->whereBetween('data', [$ini, $fim])->orderBy('data')->orderBy('odometro')->get();
            $antes = (clone $base)->where('data', '<', $ini)->orderByDesc('data')->orderByDesc('odometro')->first();
            $ultimo = (clone $base)->orderByDesc('data')->orderByDesc('odometro')->first();

            $kmMes = 0;
            if ($doMes->count()) {
                $max = $doMes->max('odometro');
                $ref = $antes?->odometro ?? $doMes->min('odometro');
                $kmMes = max(0, $max - $ref);
            }
            $motoristas = Colaborador::whereIn('id', $doMes->pluck('user_id')->unique())->pluck('nome')->values();

            $out[] = [
                'veiculo_id' => $v->id, 'placa' => $v->placa, 'modelo' => $v->modelo,
                'responsavel_nome' => $v->responsavel?->nome,
                'km_mes' => $kmMes, 'leituras_mes' => $doMes->count(),
                'ultimo_odometro' => $ultimo?->odometro, 'ultima_data' => $ultimo?->data?->format('Y-m-d'),
                'motoristas' => $motoristas,
            ];
        }

        return response()->json(['ano' => $ano, 'mes' => $mes, 'veiculos' => $out, 'total_km' => array_sum(array_column($out, 'km_mes'))]);
    }
}
