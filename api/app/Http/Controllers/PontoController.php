<?php

namespace App\Http\Controllers;

use App\Models\Colaborador;
use App\Models\Feriado;
use App\Models\Ponto;
use App\Services\PontoCalculo;
use Carbon\Carbon;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;

/**
 * Ponto de presença.
 *   bater    → o próprio colaborador; preenche a próxima marcação do dia
 *              (entrada → saída intervalo → volta → saída). Hora = do servidor,
 *              exceto quando o app manda `hora` (marcação feita sem internet).
 *   editar   → dono (só o dia corrente e o anterior) ou gestor/admin.
 *   resumo   → por colaborador no mês; gestor/admin veem todos.
 *   feriados → gestor/admin mantêm; todos leem.
 */
class PontoController extends Controller
{
    public function __construct(private PontoCalculo $calc) {}

    /* ── Marcações ────────────────────────────────────────── */
    public function index(Request $r): JsonResponse
    {
        $u = $r->user();
        $q = Ponto::query()->visiveisPara($u)->where('deleted', false)->with('colaborador:id,nome');
        if ($r->filled('ano')) {
            $q->whereYear('data', (int) $r->query('ano'));
        }
        if ($r->filled('mes')) {
            $q->whereMonth('data', (int) $r->query('mes'));
        }
        if ($r->filled('user_id')) {
            $q->where('user_id', $r->query('user_id'));
        }
        $q->orderByDesc('data');

        return response()->json($q->get()->map(fn ($p) => $this->json($p)));
    }

    /** POST /ponto/bater {hora?, lat?, lng?, marcacao?} */
    public function bater(Request $r): JsonResponse
    {
        $u = $r->user();
        $d = $r->validate([
            'hora' => ['nullable', 'date'],              // ISO do app (offline); senão agora
            'marcacao' => ['nullable', Rule::in(Ponto::MARCACOES)],
            'lat' => ['nullable', 'numeric'], 'lng' => ['nullable', 'numeric'],
            'observacao' => ['nullable', 'string', 'max:500'],
        ]);
        $hora = ($d['hora'] ?? null) ? Carbon::parse($d['hora'])->setTimezone(PontoCalculo::TZ) : Carbon::now(PontoCalculo::TZ);
        $data = $hora->format('Y-m-d');

        $p = Ponto::firstOrNew(['user_id' => $u->id, 'data' => $data]);
        if (! $p->exists) {
            $p->id = (string) Str::uuid();
            $p->tipo_dia = 'trabalho';
        }
        $marc = $d['marcacao'] ?? null;
        if (! $marc) {
            foreach (Ponto::MARCACOES as $m) {
                if (! $p->{$m}) { $marc = $m; break; }
            }
        }
        if (! $marc) {
            return response()->json(['message' => 'As quatro marcações de hoje já foram feitas. Para corrigir, edite o dia.'], 422);
        }
        /* nunca deixa uma marcação anterior à precedente (relógio errado / offline atrasado) */
        $ordem = array_search($marc, Ponto::MARCACOES, true);
        for ($i = $ordem - 1; $i >= 0; $i--) {
            $ant = $p->{Ponto::MARCACOES[$i]};
            if ($ant && $hora->lt($ant)) {
                return response()->json(['message' => 'Hora anterior à marcação já feita ('.$ant->format('H:i').'). Confira o relógio do aparelho.'], 422);
            }
        }
        $p->{$marc} = $hora;
        if ($marc === 'entrada') {
            $p->lat = $d['lat'] ?? null;
            $p->lng = $d['lng'] ?? null;
        }
        if (! empty($d['observacao'])) {
            $p->observacao = trim(($p->observacao ? $p->observacao.' · ' : '').$d['observacao']);
        }
        $p->deleted = false;
        $p->save();

        return response()->json(['marcacao' => $marc] + $this->json($p->fresh('colaborador')));
    }

    /** PUT /ponto/{id} — edição completa do dia (correções). */
    public function upsert(Request $r, string $id): JsonResponse
    {
        $u = $r->user();
        $d = $r->validate([
            'user_id' => ['nullable', 'string', 'size:36', Rule::exists('colaboradores', 'id')],
            'data' => ['required', 'date_format:Y-m-d'],
            'entrada' => ['nullable', 'date_format:H:i'],
            'saida_intervalo' => ['nullable', 'date_format:H:i'],
            'volta_intervalo' => ['nullable', 'date_format:H:i'],
            'saida' => ['nullable', 'date_format:H:i'],
            'tipo_dia' => ['nullable', Rule::in(Ponto::TIPOS_DIA)],
            'observacao' => ['nullable', 'string', 'max:500'],
        ]);
        $dono = $d['user_id'] ?? $u->id;
        $p = Ponto::find($id) ?? Ponto::where('user_id', $dono)->where('data', $d['data'])->first();
        if ($p) {
            $dono = $p->user_id;
        }
        $ehDono = $dono === $u->id;
        abort_unless($ehDono || $u->gerencia(), 403, 'Sem permissão para este ponto');
        if ($ehDono && ! $u->gerencia()) {
            /* colaborador corrige só hoje e ontem; mais antigo é com o gestor */
            $lim = Carbon::now(PontoCalculo::TZ)->subDays(1)->format('Y-m-d');
            abort_if($d['data'] < $lim, 403, 'Só é possível corrigir o ponto de hoje e de ontem; para dias anteriores, peça ao gestor');
        }
        if (! $p) {
            $p = new Ponto(['id' => $id, 'user_id' => $dono, 'data' => $d['data']]);
        }
        foreach (Ponto::MARCACOES as $m) {
            if (array_key_exists($m, $d)) {
                $p->{$m} = $d[$m] ? Carbon::parse($d['data'].' '.$d[$m], PontoCalculo::TZ) : null;
            }
        }
        $ultimo = null;
        foreach (Ponto::MARCACOES as $m) {
            if ($p->{$m}) {
                if ($ultimo && $p->{$m}->lt($ultimo)) {
                    return response()->json(['message' => 'As marcações precisam estar em ordem (entrada → intervalo → volta → saída).'], 422);
                }
                $ultimo = $p->{$m};
            }
        }
        $p->tipo_dia = $d['tipo_dia'] ?? $p->tipo_dia ?? 'trabalho';
        $p->observacao = $d['observacao'] ?? $p->observacao;
        $p->deleted = false;
        $p->save();

        return response()->json($this->json($p->fresh('colaborador')));
    }

    public function destroy(Request $r, string $id): JsonResponse
    {
        $u = $r->user();
        $p = Ponto::findOrFail($id);
        abort_unless($u->gerencia() || ($p->user_id === $u->id && $p->data->format('Y-m-d') === Carbon::now(PontoCalculo::TZ)->format('Y-m-d')), 403, 'Sem permissão');
        $p->delete();

        return response()->json(['ok' => true]);
    }

    private function json(Ponto $p): array
    {
        $c = $this->calc->calcular($p);
        $h = fn ($v) => $v?->format('H:i');

        return [
            'id' => $p->id, 'user_id' => $p->user_id, 'user_nome' => $p->colaborador?->nome,
            'data' => $p->data->format('Y-m-d'), 'dia_semana' => (int) Carbon::parse($p->data)->dayOfWeek,
            'entrada' => $h($p->entrada), 'saida_intervalo' => $h($p->saida_intervalo), 'volta_intervalo' => $h($p->volta_intervalo), 'saida' => $h($p->saida),
            'tipo_dia' => $p->tipo_dia, 'observacao' => $p->observacao, 'lat' => $p->lat, 'lng' => $p->lng,
            'minutos' => $c['minutos'], 'intervalo' => $c['intervalo'], 'normal' => $c['normal'], 'extra50' => $c['extra50'], 'extra100' => $c['extra100'],
            'domingo' => $c['domingo'], 'feriado' => $c['feriado'], 'aberto' => $c['aberto'], 'jornada' => $c['jornada'],
            'updated_at' => $p->updated_at?->toIso8601String(),
        ];
    }

    /* ── Resumo do mês (dashboard/planilha) ───────────────── */
    public function resumo(Request $r): JsonResponse
    {
        $u = $r->user();
        $ano = (int) $r->query('ano', now()->year);
        $mes = (int) $r->query('mes', now()->month);
        $ini = sprintf('%04d-%02d-01', $ano, $mes);
        $fim = date('Y-m-t', strtotime($ini));

        $pontos = Ponto::query()->visiveisPara($u)->where('deleted', false)->whereBetween('data', [$ini, $fim])
            ->with('colaborador:id,nome')->orderBy('data')->get();
        $porPessoa = [];
        $dias = [];
        foreach ($pontos as $p) {
            $j = $this->json($p);
            $dias[] = $j;
            $k = $p->user_id;
            $porPessoa[$k] ??= ['user_id' => $k, 'nome' => $p->colaborador?->nome ?? '?', 'dias' => 0, 'minutos' => 0, 'normal' => 0, 'extra50' => 0, 'extra100' => 0,
                'domingos' => 0, 'feriados' => 0, 'abertos' => 0, 'folgas' => 0, 'atestados' => 0, 'faltas' => 0, 'por_dia' => array_fill(1, 31, null)];
            $x = &$porPessoa[$k];
            $dia = (int) $p->data->format('j');
            $x['por_dia'][$dia] = $j['minutos'];
            if ($j['tipo_dia'] === 'trabalho' && ($j['minutos'] > 0 || $j['aberto'])) {
                $x['dias']++;
            }
            $x['minutos'] += $j['minutos']; $x['normal'] += $j['normal']; $x['extra50'] += $j['extra50']; $x['extra100'] += $j['extra100'];
            if ($j['minutos'] > 0 && $j['domingo']) { $x['domingos']++; }
            if ($j['minutos'] > 0 && $j['feriado']) { $x['feriados']++; }
            if ($j['aberto']) { $x['abertos']++; }
            if ($j['tipo_dia'] === 'folga') { $x['folgas']++; }
            if ($j['tipo_dia'] === 'atestado') { $x['atestados']++; }
            if ($j['tipo_dia'] === 'falta') { $x['faltas']++; }
            unset($x);
        }
        $pessoas = array_values($porPessoa);
        foreach ($pessoas as &$x) { $x['por_dia'] = array_values($x['por_dia']); }
        usort($pessoas, fn ($a, $b) => strcmp($a['nome'], $b['nome']));

        $feriadosMes = Feriado::query()->whereBetween('data', [$ini, $fim])->orderBy('data')->get(['data', 'nome']);
        $tot = ['minutos' => 0, 'normal' => 0, 'extra50' => 0, 'extra100' => 0, 'domingos' => 0, 'feriados' => 0, 'dias' => 0];
        foreach ($pessoas as $x) { foreach ($tot as $c => $_) { $tot[$c] += $x[$c]; } }

        return response()->json(['ano' => $ano, 'mes' => $mes, 'pessoas' => $pessoas, 'dias' => $dias, 'feriados' => $feriadosMes, 'total' => $tot,
            'jornada' => PontoCalculo::JORNADA]);
    }

    /* ── Feriados ─────────────────────────────────────────── */
    public function feriados(Request $r): JsonResponse
    {
        $q = Feriado::query()->orderBy('data');
        if ($r->filled('ano')) {
            $q->whereYear('data', (int) $r->query('ano'));
        }

        return response()->json($q->get(['data', 'nome']));
    }

    public function feriadoUpsert(Request $r): JsonResponse
    {
        abort_unless($r->user()->gerencia(), 403, 'Só gestor/admin mantêm feriados');
        $d = $r->validate(['data' => ['required', 'date_format:Y-m-d'], 'nome' => ['required', 'string', 'max:80']]);
        $f = Feriado::updateOrCreate(['data' => $d['data']], ['nome' => $d['nome']]);

        return response()->json($f);
    }

    public function feriadoDelete(Request $r, string $data): JsonResponse
    {
        abort_unless($r->user()->gerencia(), 403, 'Só gestor/admin mantêm feriados');
        Feriado::where('data', $data)->delete();

        return response()->json(['ok' => true]);
    }
}
