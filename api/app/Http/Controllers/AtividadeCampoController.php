<?php

namespace App\Http\Controllers;

use App\Models\AtividadeCampo;
use App\Models\CampoCadastro;
use App\Models\Colaborador;
use Carbon\Carbon;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;

/**
 * Atividade em campo (08/11/2026).
 *   iniciar    → a própria pessoa, se o gestor ligou a função para ela. Fecha sozinha a atividade que ficou aberta.
 *   finalizar  → a própria pessoa, na atividade dela.
 *   index      → lista do período; o dono vê as próprias, gestor/admin veem todas.
 *   equipe     → gestor/admin: o último registro de cada pessoa com a função ligada (quem está em campo agora e onde).
 *
 * Hora: a do servidor, exceto quando o app manda `hora` (toque feito sem internet que subiu depois). O id vem do aparelho
 * (UUID), então reenviar o mesmo toque não duplica.
 */
class AtividadeCampoController extends Controller
{
    private const TZ = 'America/Sao_Paulo';

    /** Tolerância para relógio de aparelho adiantado. */
    private const FUTURO_MAX_MIN = 5;

    private function localizacao(): array
    {
        return [
            'hora' => ['nullable', 'date'],
            'lat' => ['nullable', 'numeric', 'between:-90,90'],
            'lng' => ['nullable', 'numeric', 'between:-180,180'],
            'precisao' => ['nullable', 'numeric', 'min:0', 'max:1000000'],
        ];
    }

    /* O banco guarda a hora de Brasília "de parede" (como o ponto); o cast lê no fuso do app. Isto devolve o instante certo. */
    private function br(?Carbon $c): ?Carbon
    {
        return $c ? Carbon::parse($c->format('Y-m-d H:i:s'), self::TZ) : null;
    }

    private function hora(?string $iso): Carbon
    {
        $agora = Carbon::now(self::TZ);
        if (! $iso) {
            return $agora;
        }
        $h = Carbon::parse($iso)->setTimezone(self::TZ);
        abort_if($h->gt($agora->copy()->addMinutes(self::FUTURO_MAX_MIN)), 422, 'Hora no futuro. Confira o relógio do aparelho.');

        return $h;
    }

    /** POST /atividades-campo/iniciar {id, fazenda, campo, hora?, lat?, lng?, precisao?, observacao?} */
    public function iniciar(Request $r): JsonResponse
    {
        $u = $r->user();
        abort_unless($u->registraAtividadeCampo(), 403, 'A atividade em campo não está liberada para a sua conta. Peça ao gestor.');
        $d = $r->validate([
            'id' => ['required', 'uuid'],
            'fazenda' => ['required', 'string', 'max:120'],
            'campo' => ['required', 'string', 'max:60'],
            'observacao' => ['nullable', 'string', 'max:500'],
        ] + $this->localizacao());

        /* reenvio do mesmo toque (fila offline): devolve o que já existe */
        if ($ja = AtividadeCampo::find($d['id'])) {
            abort_unless($ja->user_id === $u->id, 403, 'Identificador já usado.');

            return response()->json($this->json($ja->load('colaborador:id,nome')));
        }

        $hora = $this->hora($d['hora'] ?? null);

        /* Esqueceu de finalizar o campo anterior? Fecha na hora deste início (pedido do Paulo: "quando ele inicia o outro
           campo, registra o fechamento automático do outro"). Só fecha o que começou antes; a localização do fim fica vazia. */
        AtividadeCampo::where('user_id', $u->id)->whereNull('fim')->where('inicio', '<=', $hora)
            ->get()->each(fn (AtividadeCampo $a) => $a->update(['fim' => $hora, 'fim_automatico' => true]));

        $a = AtividadeCampo::create([
            'id' => $d['id'], 'user_id' => $u->id,
            'fazenda' => trim($d['fazenda']), 'campo' => mb_strtoupper(trim($d['campo'])),
            'inicio' => $hora,
            'lat_inicio' => $d['lat'] ?? null, 'lng_inicio' => $d['lng'] ?? null,
            'precisao_inicio' => isset($d['precisao']) ? (int) round($d['precisao']) : null,
            'observacao' => $d['observacao'] ?? null,
        ]);

        return response()->json($this->json($a->load('colaborador:id,nome')), 201);
    }

    /** POST /atividades-campo/{id}/finalizar {hora?, lat?, lng?, precisao?} */
    public function finalizar(Request $r, string $id): JsonResponse
    {
        $u = $r->user();
        $a = AtividadeCampo::findOrFail($id);
        abort_unless($a->user_id === $u->id, 403, 'Só quem iniciou finaliza a atividade.');
        $d = $r->validate($this->localizacao());

        /* Já fechada (reenvio, ou fechada sozinha quando outro campo começou): o fim manual vale se vier com localização
           e a atividade tinha sido fechada só pelo automático. Fora isso, nada muda. */
        if ($a->fim && ! $a->fim_automatico) {
            return response()->json($this->json($a->load('colaborador:id,nome')));
        }
        $hora = $this->hora($d['hora'] ?? null);
        if ($hora->lt($this->br($a->inicio))) {
            return response()->json(['message' => 'Hora do fim anterior ao início ('.$a->inicio->format('H:i').'). Confira o relógio do aparelho.'], 422);
        }
        if ($a->fim && $a->fim_automatico && $hora->gt($this->br($a->fim))) {
            /* o automático fechou na hora do início seguinte; um fim manual depois disso não cabe */
            return response()->json($this->json($a->load('colaborador:id,nome')));
        }
        $a->update([
            'fim' => $hora, 'fim_automatico' => false,
            'lat_fim' => $d['lat'] ?? null, 'lng_fim' => $d['lng'] ?? null,
            'precisao_fim' => isset($d['precisao']) ? (int) round($d['precisao']) : null,
        ]);

        return response()->json($this->json($a->fresh('colaborador:id,nome')));
    }

    /** GET /atividades-campo?de=AAAA-MM-DD&ate=AAAA-MM-DD&user_id= */
    public function index(Request $r): JsonResponse
    {
        $u = $r->user();
        $d = $r->validate([
            'de' => ['nullable', 'date_format:Y-m-d'], 'ate' => ['nullable', 'date_format:Y-m-d'],
            'user_id' => ['nullable', 'string', 'size:36'],
        ]);
        $de = Carbon::parse($d['de'] ?? Carbon::now(self::TZ)->subDays(30)->format('Y-m-d'), self::TZ)->startOfDay();
        $ate = Carbon::parse($d['ate'] ?? Carbon::now(self::TZ)->format('Y-m-d'), self::TZ)->endOfDay();
        abort_if($de->gt($ate), 422, 'A data inicial é depois da final.');
        abort_if($de->diffInDays($ate) > 400, 422, 'Período longo demais: escolha até um ano.');

        $q = AtividadeCampo::query()->visiveisPara($u)->with('colaborador:id,nome')
            ->whereBetween('inicio', [$de, $ate])->orderByDesc('inicio');
        if (! empty($d['user_id'])) {
            $q->where('user_id', $d['user_id']);
        }

        return response()->json($q->limit(5000)->get()->map(fn ($a) => $this->json($a)));
    }

    /**
     * GET /atividades-campo/campos — fazendas e campos já registrados (buscador do início, 08/11/2026).
     * Da equipe inteira no último ano: o campo que um colega já cadastrou aparece para os outros, sem redigitar.
     * Só nomes de fazenda e campo, quantas vezes e quando; nada de localização nem de quem foi.
     */
    public function campos(Request $r): JsonResponse
    {
        $u = $r->user();
        abort_unless($u->registraAtividadeCampo() || $u->acompanhaCampo(), 403, 'A atividade em campo não está liberada para a sua conta.');

        $desde = Carbon::now(self::TZ)->subYear()->format('Y-m-d H:i:s');
        $chave = fn (string $f, string $c) => CampoCadastro::chave($f, $c);
        $lista = [];
        AtividadeCampo::query()->where('inicio', '>=', $desde)->orderByDesc('inicio')->limit(20000)
            ->get(['user_id', 'fazenda', 'campo', 'inicio'])
            ->each(function (AtividadeCampo $a) use (&$lista, $chave, $u) {
                $k = $chave($a->fazenda, $a->campo);
                $lista[$k] ??= ['fazenda' => $a->fazenda, 'campo' => mb_strtoupper($a->campo), 'usos' => 0, 'meus' => 0,
                    'ultimo_uso' => $this->br($a->inicio)?->toIso8601String()];
                $lista[$k]['usos']++;
                if ($a->user_id === $u->id) {
                    $lista[$k]['meus']++;
                }
            });

        /* campos cadastrados (09/11/2026): o nome do cadastro vale (é o corrigido); os nunca visitados entram no fim */
        if (CampoCadastro::tabelaExiste()) {
            CampoCadastro::query()->orderBy('fazenda')->orderBy('campo')->limit(5000)->get()
                ->each(function (CampoCadastro $c) use (&$lista) {
                    $lista[$c->chave] = ['fazenda' => $c->fazenda, 'campo' => $c->campo, 'cadastrado' => true]
                        + ($lista[$c->chave] ?? ['usos' => 0, 'meus' => 0, 'ultimo_uso' => null]);
                });
        }

        return response()->json(array_values(array_slice($lista, 0, 6000)));
    }

    /** POST /atividades-campo/campos {fazenda, campo} — gestor, admin ou focal cadastram um campo novo (09/11/2026). */
    public function cadastrarCampo(Request $r): JsonResponse
    {
        abort_unless($r->user()->acompanhaCampo(), 403, 'Só gestor, administrador ou focal cadastra campo.');
        abort_unless(CampoCadastro::tabelaExiste(), 503, 'Falta atualizar a estrutura do banco. Avise o administrador.');
        $d = $r->validate(['fazenda' => ['required', 'string', 'max:120'], 'campo' => ['required', 'string', 'max:60']]);
        $fazenda = trim($d['fazenda']);
        $campo = mb_strtoupper(trim($d['campo']));
        abort_if($fazenda === '' || $campo === '', 422, 'Informe a fazenda e o campo.');
        $k = CampoCadastro::chave($fazenda, $campo);
        abort_if(CampoCadastro::where('chave', $k)->exists(), 409, 'Este campo já está cadastrado.');

        $c = CampoCadastro::create(['id' => (string) Str::uuid(), 'fazenda' => $fazenda, 'campo' => $campo, 'chave' => $k, 'criado_por' => $r->user()->id]);

        return response()->json(['fazenda' => $c->fazenda, 'campo' => $c->campo, 'cadastrado' => true], 201);
    }

    /**
     * PUT /atividades-campo/campos {fazenda_antiga, campo_antigo, fazenda, campo, corrigir_registros?} — corrigir o nome de
     * um campo (09/11/2026). Vale para campo cadastrado e para o que só existe nos registros (este entra no cadastro).
     * Os registros antigos só mudam se `corrigir_registros` vier ligado; a localização e as horas nunca mudam.
     */
    public function editarCampo(Request $r): JsonResponse
    {
        $u = $r->user();
        abort_unless($u->acompanhaCampo(), 403, 'Só gestor, administrador ou focal corrige campo.');
        abort_unless(CampoCadastro::tabelaExiste(), 503, 'Falta atualizar a estrutura do banco. Avise o administrador.');
        $d = $r->validate([
            'fazenda_antiga' => ['required', 'string', 'max:120'], 'campo_antigo' => ['required', 'string', 'max:60'],
            'fazenda' => ['required', 'string', 'max:120'], 'campo' => ['required', 'string', 'max:60'],
            'corrigir_registros' => ['sometimes', 'boolean'],
        ]);
        $fazenda = trim($d['fazenda']);
        $campo = mb_strtoupper(trim($d['campo']));
        abort_if($fazenda === '' || $campo === '', 422, 'Informe a fazenda e o campo.');
        $antiga = CampoCadastro::chave($d['fazenda_antiga'], $d['campo_antigo']);
        $nova = CampoCadastro::chave($fazenda, $campo);
        $registros = AtividadeCampo::query()->where('campo', mb_strtoupper(trim($d['campo_antigo'])))->get()
            ->filter(fn (AtividadeCampo $a) => CampoCadastro::chave($a->fazenda, $a->campo) === $antiga);
        $existe = CampoCadastro::where('chave', $antiga)->first();
        $destino = $nova === $antiga ? null : CampoCadastro::where('chave', $nova)->first();
        abort_if(! $existe && $registros->isEmpty(), 404, 'Campo não encontrado.');
        /* dois campos cadastrados não viram um só; já um nome antigo que só existe nos registros pode ir para um
           cadastrado (é o "corrigir os registros antigos" depois de já ter corrigido o cadastro) */
        abort_if($existe && $destino, 409, 'Já existe um campo cadastrado com esse nome.');

        $corrigidos = 0;
        DB::transaction(function () use ($existe, $destino, $fazenda, $campo, $nova, $u, $d, $registros, &$corrigidos) {
            if ($existe) {
                $existe->update(['fazenda' => $fazenda, 'campo' => $campo, 'chave' => $nova]);
            } elseif ($destino) {
                $destino->update(['fazenda' => $fazenda, 'campo' => $campo]);
            } else {
                CampoCadastro::create(['id' => (string) Str::uuid(), 'fazenda' => $fazenda, 'campo' => $campo, 'chave' => $nova, 'criado_por' => $u->id]);
            }
            if (! empty($d['corrigir_registros'])) {
                foreach ($registros as $a) {
                    $a->update(['fazenda' => $fazenda, 'campo' => $campo]);
                    $corrigidos++;
                }
            }
        });
        Log::info('campo.corrigido', ['por' => $u->id, 'de' => $d['fazenda_antiga'].' / '.$d['campo_antigo'], 'para' => "{$fazenda} / {$campo}", 'registros' => $corrigidos]);

        return response()->json(['fazenda' => $fazenda, 'campo' => $campo, 'cadastrado' => true, 'registros_corrigidos' => $corrigidos]);
    }

    /** GET /atividades-campo/equipe — último registro de cada pessoa com a função ligada. */
    public function equipe(Request $r): JsonResponse
    {
        abort_unless($r->user()->acompanhaCampo(), 403, 'Só gestor, administrador ou focal acompanha a equipe em campo.');

        $pessoas = Colaborador::query()->where('ativo', true)->where('atividade_campo', true)->orderBy('nome')->get(['id', 'nome']);
        $ultimas = AtividadeCampo::query()->whereIn('user_id', $pessoas->pluck('id'))
            ->orderByDesc('inicio')->get()->groupBy('user_id')->map->first();

        return response()->json($pessoas->map(function (Colaborador $p) use ($ultimas) {
            $a = $ultimas->get($p->id);

            return ['user_id' => $p->id, 'nome' => $p->nome, 'ultima' => $a ? $this->json($a->setRelation('colaborador', $p)) : null];
        })->values());
    }

    private function json(AtividadeCampo $a): array
    {
        $iso = fn (?Carbon $c) => $this->br($c)?->toIso8601String();
        $min = $a->fim ? (int) $a->inicio->diffInMinutes($a->fim, true) : null;

        return [
            'id' => $a->id, 'user_id' => $a->user_id, 'user_nome' => $a->colaborador?->nome,
            'fazenda' => $a->fazenda, 'campo' => $a->campo,
            'inicio' => $iso($a->inicio), 'fim' => $iso($a->fim), 'em_campo' => $a->fim === null,
            'fim_automatico' => (bool) $a->fim_automatico, 'minutos' => $min,
            'lat_inicio' => $a->lat_inicio, 'lng_inicio' => $a->lng_inicio, 'precisao_inicio' => $a->precisao_inicio,
            'lat_fim' => $a->lat_fim, 'lng_fim' => $a->lng_fim, 'precisao_fim' => $a->precisao_fim,
            'observacao' => $a->observacao,
            'updated_at' => $a->updated_at?->toIso8601String(),
        ];
    }
}
