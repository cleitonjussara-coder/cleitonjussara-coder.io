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

    /** Até quanto tempo para trás vale a hora do aparelho (fila sem internet). Auditoria 09/11, item 3 — decisão do Cleiton: 24 h. */
    private const PASSADO_MAX_H = 24;

    /** Diferença entre o toque e a chegada ao servidor a partir da qual o gestor vê "registrado depois". */
    private const ATRASO_SELO_MIN = 15;

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

    /* $doAparelho: início/fim vindos da fila do aparelho têm o limite para trás; a correção do gestor/focal (editar) não. */
    private function hora(?string $iso, bool $doAparelho = true): Carbon
    {
        $agora = Carbon::now(self::TZ);
        if (! $iso) {
            return $agora;
        }
        $h = Carbon::parse($iso)->setTimezone(self::TZ);
        abort_if($h->gt($agora->copy()->addMinutes(self::FUTURO_MAX_MIN)), 422, 'Hora no futuro. Confira o relógio do aparelho.');
        abort_if($doAparelho && $h->lt($agora->copy()->subHours(self::PASSADO_MAX_H)), 422,
            'Registro de mais de '.self::PASSADO_MAX_H.' horas atrás. Peça ao gestor ou ao focal para lançar a hora certa.');

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
        AtividadeCampo::query()->vivos()->where('user_id', $u->id)->whereNull('fim')->where('inicio', '<=', $hora)
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
        abort_if(AtividadeCampo::temLixeira() && $a->apagado_em, 409, 'Este registro foi apagado. Se foi engano, restaure na lixeira.');
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

    /**
     * PATCH /atividades-campo/{id} {fazenda?, campo?, observacao?, inicio?, fim?} — corrigir registro (09/11/2026).
     * Dono e gestor/admin corrigem fazenda, campo e observação; só gestor/admin mexem na hora. A localização nunca muda.
     * O registro fica marcado como editado (quando e por quem) e o antes/depois vai para o log.
     */
    public function editar(Request $r, string $id): JsonResponse
    {
        $u = $r->user();
        abort_unless(AtividadeCampo::temEdicao(), 503, 'Falta atualizar a estrutura do banco para corrigir registros. Avise o administrador.');
        $a = AtividadeCampo::query()->vivos()->visiveisPara($u)->findOrFail($id);
        $d = $r->validate([
            'fazenda' => ['sometimes', 'required', 'string', 'max:120'],
            'campo' => ['sometimes', 'required', 'string', 'max:60'],
            'observacao' => ['sometimes', 'nullable', 'string', 'max:500'],
            'inicio' => ['sometimes', 'required', 'date'],
            'fim' => ['sometimes', 'nullable', 'date'],
        ]);
        $mexeHora = array_key_exists('inicio', $d) || array_key_exists('fim', $d);
        abort_if($mexeHora && ! $u->acompanhaCampo(), 403, 'Só o gestor ou o focal corrige a hora. Peça a eles.');   // focal (09/11/2026) também

        $novo = [];
        if (array_key_exists('fazenda', $d)) {
            $novo['fazenda'] = trim($d['fazenda']);
        }
        if (array_key_exists('campo', $d)) {
            $novo['campo'] = mb_strtoupper(trim($d['campo']));
        }
        if (array_key_exists('observacao', $d)) {
            $novo['observacao'] = ($o = trim((string) $d['observacao'])) === '' ? null : $o;
        }
        $inicio = $this->br($a->inicio);
        $fim = $this->br($a->fim);
        /* hora igual à gravada não passa pela checagem de "futuro" de novo: só o que mudou é conferido */
        $igual = fn (?string $iso, ?Carbon $atual) => $iso && $atual && Carbon::parse($iso)->eq($atual);
        if (array_key_exists('inicio', $d) && ! $igual($d['inicio'], $inicio)) {
            $inicio = $this->hora($d['inicio'], false);
        }
        if (array_key_exists('fim', $d)) {
            abort_if($d['fim'] === null && $a->fim !== null, 422, 'Não dá para reabrir uma atividade já encerrada.');
            if (! $igual($d['fim'], $fim)) {
                $fim = $d['fim'] === null ? null : $this->hora($d['fim'], false);
            }
        }
        abort_if($fim && $fim->lt($inicio), 422, 'O fim ficou antes do início. Confira as horas.');
        if (array_key_exists('inicio', $d) && ! $inicio->eq($this->br($a->inicio))) {
            $novo['inicio'] = $inicio;
        }
        if (array_key_exists('fim', $d) && $fim && (! $a->fim || ! $fim->eq($this->br($a->fim)))) {
            $novo['fim'] = $fim;
            $novo['fim_automatico'] = false;   // o gestor conferiu a hora
        }

        /* só marca "editado" se algo mudou de verdade */
        $mudou = array_filter($novo, fn ($v, $k) => $k === 'fim_automatico' || $k === 'inicio' || $k === 'fim' || $a->{$k} !== $v, ARRAY_FILTER_USE_BOTH);
        if ($mudou) {
            $antes = array_intersect_key($a->only(array_keys($mudou)), $mudou);
            $a->update($mudou + ['editado_em' => Carbon::now(self::TZ), 'editado_por' => $u->id]);
            \Illuminate\Support\Facades\Log::info('atividade_campo.editada', ['id' => $a->id, 'por' => $u->id, 'antes' => $antes,
                'depois' => array_map(fn ($v) => $v instanceof Carbon ? $v->format('Y-m-d H:i:s') : $v, $mudou)]);
        }

        return response()->json($this->json($a->fresh(['colaborador:id,nome', 'editor:id,nome'])));
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

        $q = AtividadeCampo::query()->vivos()->visiveisPara($u)->with(AtividadeCampo::temEdicao() ? ['colaborador:id,nome', 'editor:id,nome'] : ['colaborador:id,nome'])
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
        AtividadeCampo::query()->vivos()->where('inicio', '>=', $desde)->orderByDesc('inicio')->limit(20000)
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

        /* campos cadastrados (09/11/2026): o nome do cadastro vale (é o corrigido); os nunca visitados entram no fim.
           Campo na lixeira some do buscador, mesmo que haja registros com o nome. `com_apagados=1` (app novo) devolve
           também os apagados, marcados, para o aparelho tirá-los do histórico local. */
        $apagados = [];
        if (CampoCadastro::tabelaExiste()) {
            CampoCadastro::query()->orderBy('fazenda')->orderBy('campo')->limit(5000)->get()
                ->each(function (CampoCadastro $c) use (&$lista, &$apagados) {
                    if ($c->apagado) {
                        unset($lista[$c->chave]);
                        $apagados[] = ['fazenda' => $c->fazenda, 'campo' => $c->campo, 'apagado' => true];

                        return;
                    }
                    $lista[$c->chave] = ['fazenda' => $c->fazenda, 'campo' => $c->campo, 'cadastrado' => true]
                        + ($lista[$c->chave] ?? ['usos' => 0, 'meus' => 0, 'ultimo_uso' => null]);
                });
        }
        $saida = array_values(array_slice($lista, 0, 6000));

        return response()->json($r->boolean('com_apagados') ? array_merge($saida, $apagados) : $saida);
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
        $ja = CampoCadastro::where('chave', $k)->first();
        if ($ja?->apagado) {
            /* cadastrar de novo um campo que estava na lixeira = restaurar, com o nome como foi digitado agora */
            $ja->update(['fazenda' => $fazenda, 'campo' => $campo, 'apagado_em' => null, 'apagado_por' => null]);
            Log::info('campo.restaurado', ['por' => $r->user()->id, 'campo' => "{$fazenda} / {$campo}", 'via' => 'cadastro']);

            return response()->json(['fazenda' => $ja->fazenda, 'campo' => $ja->campo, 'cadastrado' => true, 'restaurado' => true], 201);
        }
        abort_if($ja, 409, 'Este campo já está cadastrado.');

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
        $registros = AtividadeCampo::query()->vivos()->where('campo', mb_strtoupper(trim($d['campo_antigo'])))->get()
            ->filter(fn (AtividadeCampo $a) => CampoCadastro::chave($a->fazenda, $a->campo) === $antiga);
        $existe = CampoCadastro::where('chave', $antiga)->first();
        $destino = $nova === $antiga ? null : CampoCadastro::where('chave', $nova)->first();
        abort_if(! $existe && $registros->isEmpty(), 404, 'Campo não encontrado.');
        /* dois campos cadastrados não viram um só; já um nome antigo que só existe nos registros pode ir para um
           cadastrado (é o "corrigir os registros antigos" depois de já ter corrigido o cadastro) */
        abort_if($existe?->apagado, 409, 'Este campo está na lixeira. Restaure antes de corrigir.');
        abort_if($destino?->apagado, 409, 'Um campo com esse nome está na lixeira. Restaure-o ou apague de vez antes.');
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
        /* 10/11/2026 (auditoria, item 4): só o último de cada pessoa sai do banco — antes vinha o histórico inteiro */
        $ids = $pessoas->pluck('id');
        $maior = AtividadeCampo::query()->vivos()->whereIn('user_id', $ids)
            ->groupBy('user_id')->selectRaw('user_id as uid, MAX(inicio) as ultimo');
        $ultimas = AtividadeCampo::query()->vivos()->whereIn('atividades_campo.user_id', $ids)
            ->joinSub($maior, 'u', fn ($j) => $j->on('atividades_campo.user_id', '=', 'u.uid')->on('atividades_campo.inicio', '=', 'u.ultimo'))
            ->select('atividades_campo.*')->orderByDesc('atividades_campo.inicio')->get()->groupBy('user_id')->map->first();

        return response()->json($pessoas->map(function (Colaborador $p) use ($ultimas) {
            $a = $ultimas->get($p->id);

            return ['user_id' => $p->id, 'nome' => $p->nome, 'ultima' => $a ? $this->json($a->setRelation('colaborador', $p)) : null];
        })->values());
    }

    /* ── Lixeira (09/11/2026, pedido do Cleiton) ─────────────────────────────────────────────────────────────────────
       Registro: o dono, o gestor, o admin e o focal mandam para a lixeira e restauram. Campo cadastrado: gestor, admin e
       focal. Apagar de vez: só gestor e admin, e só o que JÁ está na lixeira (409 fora dela, como nas notas). Nada é
       apagado sozinho; o antes vai para o log. */

    private function exigeLixeira(): void
    {
        abort_unless(AtividadeCampo::temLixeira() && CampoCadastro::temLixeira(), 503, 'Falta atualizar a estrutura do banco para a lixeira. Avise o administrador.');
    }

    /** DELETE /atividades-campo/{id} — manda o registro para a lixeira. */
    public function apagar(Request $r, string $id): JsonResponse
    {
        $u = $r->user();
        $this->exigeLixeira();
        $a = AtividadeCampo::query()->visiveisPara($u)->findOrFail($id);
        if (! $a->apagado_em) {
            $a->update(['apagado_em' => Carbon::now(self::TZ), 'apagado_por' => $u->id]);
            Log::info('atividade_campo.lixeira', ['id' => $a->id, 'por' => $u->id, 'dono' => $a->user_id, 'campo' => "{$a->fazenda} / {$a->campo}"]);
        }

        return response()->json($this->json($a->fresh(['colaborador:id,nome', 'apagador:id,nome'])));
    }

    /** POST /atividades-campo/{id}/restaurar — tira da lixeira. */
    public function restaurar(Request $r, string $id): JsonResponse
    {
        $u = $r->user();
        $this->exigeLixeira();
        $a = AtividadeCampo::query()->visiveisPara($u)->findOrFail($id);
        if ($a->apagado_em) {
            $novo = ['apagado_em' => null, 'apagado_por' => null];
            /* estava "em campo" e a pessoa já começou outro depois: fecha na hora desse início, como o fim automático */
            $seguinte = $a->fim ? null : AtividadeCampo::query()->vivos()->where('user_id', $a->user_id)
                ->where('inicio', '>', $a->inicio)->orderBy('inicio')->first();
            if ($seguinte) {
                $novo += ['fim' => $seguinte->inicio, 'fim_automatico' => true];
            }
            $a->update($novo);
            Log::info('atividade_campo.restaurada', ['id' => $a->id, 'por' => $u->id]);
        }

        return response()->json($this->json($a->fresh('colaborador:id,nome')));
    }

    /** DELETE /atividades-campo/{id}/definitivo — gestor ou admin apagam de vez o que está na lixeira. */
    public function apagarDefinitivo(Request $r, string $id): JsonResponse
    {
        $u = $r->user();
        abort_unless($u->gerencia(), 403, 'Só o gestor ou o administrador apaga de vez.');
        $this->exigeLixeira();
        $a = AtividadeCampo::findOrFail($id);
        abort_unless($a->apagado_em, 409, 'O registro não está na lixeira. Apague primeiro.');
        Log::warning('atividade_campo.apagada_de_vez', ['por' => $u->id, 'registro' => $a->only(['id', 'user_id', 'fazenda', 'campo', 'observacao'])
            + ['inicio' => $a->inicio?->format('Y-m-d H:i:s'), 'fim' => $a->fim?->format('Y-m-d H:i:s'), 'lat_inicio' => $a->lat_inicio, 'lng_inicio' => $a->lng_inicio]]);
        $a->delete();

        return response()->json(['ok' => true]);
    }

    /** GET /atividades-campo/lixeira — registros apagados (o dono vê os próprios; gestor, admin e focal, todos). */
    public function lixeira(Request $r): JsonResponse
    {
        $u = $r->user();
        if (! AtividadeCampo::temLixeira()) {
            return response()->json([]);
        }

        return response()->json(AtividadeCampo::query()->naLixeira()->visiveisPara($u)->with(['colaborador:id,nome', 'apagador:id,nome'])
            ->orderByDesc('apagado_em')->limit(500)->get()->map(fn ($a) => $this->json($a)));
    }

    /** Campo pelo nome (fazenda + campo), cadastrado ou só nos registros. */
    private function campoPedido(Request $r): array
    {
        $d = $r->validate(['fazenda' => ['required', 'string', 'max:120'], 'campo' => ['required', 'string', 'max:60']]);

        return [trim($d['fazenda']), mb_strtoupper(trim($d['campo'])), CampoCadastro::chave($d['fazenda'], $d['campo'])];
    }

    /** Registros fora da lixeira que usam o campo (qualquer data). */
    private function registrosDoCampo(string $campo, string $chave): int
    {
        return AtividadeCampo::query()->vivos()->where('campo', $campo)->get(['fazenda', 'campo'])
            ->filter(fn (AtividadeCampo $a) => CampoCadastro::chave($a->fazenda, $a->campo) === $chave)->count();
    }

    /**
     * POST /atividades-campo/campos/apagar {fazenda, campo} — campo vai para a lixeira e some do buscador. Os registros
     * feitos nele continuam como estão. Um nome que só existia nos registros entra no cadastro já apagado.
     */
    public function apagarCampo(Request $r): JsonResponse
    {
        $u = $r->user();
        abort_unless($u->acompanhaCampo(), 403, 'Só gestor, administrador ou focal apaga campo.');
        $this->exigeLixeira();
        [$fazenda, $campo, $k] = $this->campoPedido($r);
        $c = CampoCadastro::where('chave', $k)->first();
        abort_if(! $c && ! $this->registrosDoCampo($campo, $k), 404, 'Campo não encontrado.');
        if (! $c) {
            $c = CampoCadastro::create(['id' => (string) Str::uuid(), 'fazenda' => $fazenda, 'campo' => $campo, 'chave' => $k, 'criado_por' => $u->id]);
        }
        if (! $c->apagado) {
            $c->update(['apagado_em' => Carbon::now(self::TZ), 'apagado_por' => $u->id]);
            Log::info('campo.lixeira', ['por' => $u->id, 'campo' => "{$c->fazenda} / {$c->campo}"]);
        }

        return response()->json(['fazenda' => $c->fazenda, 'campo' => $c->campo, 'apagado' => true]);
    }

    /** POST /atividades-campo/campos/restaurar {fazenda, campo} — volta ao buscador. */
    public function restaurarCampo(Request $r): JsonResponse
    {
        $u = $r->user();
        abort_unless($u->acompanhaCampo(), 403, 'Só gestor, administrador ou focal restaura campo.');
        $this->exigeLixeira();
        [, , $k] = $this->campoPedido($r);
        $c = CampoCadastro::where('chave', $k)->firstOrFail();
        if ($c->apagado) {
            $c->update(['apagado_em' => null, 'apagado_por' => null]);
            Log::info('campo.restaurado', ['por' => $u->id, 'campo' => "{$c->fazenda} / {$c->campo}"]);
        }

        return response()->json(['fazenda' => $c->fazenda, 'campo' => $c->campo, 'cadastrado' => true]);
    }

    /**
     * POST /atividades-campo/campos/definitivo {fazenda, campo} — gestor ou admin apagam de vez um campo da lixeira.
     * Se ainda há registros com esse nome, recusa (409): o nome voltaria sozinho ao buscador. Corrija ou apague os
     * registros antes.
     */
    public function apagarCampoDefinitivo(Request $r): JsonResponse
    {
        $u = $r->user();
        abort_unless($u->gerencia(), 403, 'Só o gestor ou o administrador apaga de vez.');
        $this->exigeLixeira();
        [, $campo, $k] = $this->campoPedido($r);
        $c = CampoCadastro::where('chave', $k)->firstOrFail();
        abort_unless($c->apagado, 409, 'O campo não está na lixeira. Apague primeiro.');
        $n = $this->registrosDoCampo($campo, $k);
        abort_if($n > 0, 409, ($n === 1 ? 'Há 1 registro' : "Há {$n} registros").' com este campo. Corrija o nome deles (✏️ Editar o campo) ou apague-os antes de apagar o campo de vez.');
        Log::warning('campo.apagado_de_vez', ['por' => $u->id, 'campo' => "{$c->fazenda} / {$c->campo}", 'id' => $c->id]);
        $c->delete();

        return response()->json(['ok' => true]);
    }

    /** GET /atividades-campo/campos/lixeira — campos apagados (gestor, admin e focal). */
    public function lixeiraCampos(Request $r): JsonResponse
    {
        abort_unless($r->user()->acompanhaCampo(), 403, 'Só gestor, administrador ou focal vê a lixeira dos campos.');
        if (! CampoCadastro::temLixeira()) {
            return response()->json([]);
        }
        $nomes = Colaborador::query()->pluck('nome', 'id');
        $apagados = CampoCadastro::query()->whereNotNull('apagado_em')->orderByDesc('apagado_em')->limit(500)->get();
        /* 10/11/2026 (auditoria, item 13): uma consulta para todos os campos, contada pela mesma chave de registrosDoCampo() */
        $porChave = $apagados->isEmpty() ? collect() : AtividadeCampo::query()->vivos()
            ->whereIn('campo', $apagados->pluck('campo')->unique()->values())->get(['fazenda', 'campo'])
            ->countBy(fn (AtividadeCampo $a) => CampoCadastro::chave($a->fazenda, $a->campo));

        return response()->json($apagados->map(fn (CampoCadastro $c) => [
            'fazenda' => $c->fazenda, 'campo' => $c->campo,
            'apagado_em' => $this->br($c->apagado_em)?->toIso8601String(), 'apagado_por_nome' => $nomes[$c->apagado_por] ?? null,
            'registros' => (int) ($porChave[$c->chave] ?? 0),
        ]));
    }

    private function json(AtividadeCampo $a): array
    {
        $iso = fn (?Carbon $c) => $this->br($c)?->toIso8601String();
        $min = $a->fim ? (int) $a->inicio->diffInMinutes($a->fim, true) : null;
        /* "registrado depois": o toque foi feito sem internet e chegou ao servidor bem mais tarde. created_at é a chegada
           (instante real); o início é a hora de parede de Brasília, por isso passa pelo br(). Corrigido pelo gestor não conta. */
        $atrasoIni = $a->created_at && ! $a->editado_em ? (int) floor(($a->created_at->getTimestamp() - $this->br($a->inicio)->getTimestamp()) / 60) : 0;

        return [
            'id' => $a->id, 'user_id' => $a->user_id, 'user_nome' => $a->colaborador?->nome,
            'fazenda' => $a->fazenda, 'campo' => $a->campo,
            'inicio' => $iso($a->inicio), 'fim' => $iso($a->fim), 'em_campo' => $a->fim === null,
            'fim_automatico' => (bool) $a->fim_automatico, 'minutos' => $min,
            'registrado_depois_min' => $atrasoIni >= self::ATRASO_SELO_MIN ? $atrasoIni : null,
            'lat_inicio' => $a->lat_inicio, 'lng_inicio' => $a->lng_inicio, 'precisao_inicio' => $a->precisao_inicio,
            'lat_fim' => $a->lat_fim, 'lng_fim' => $a->lng_fim, 'precisao_fim' => $a->precisao_fim,
            'observacao' => $a->observacao,
            'editado_em' => $iso($a->editado_em),
            'editado_por_nome' => $a->editado_por ? ($a->relationLoaded('editor') ? $a->editor : $a->editor()->first(['id', 'nome']))?->nome : null,
            'apagado_em' => AtividadeCampo::temLixeira() ? $iso($a->apagado_em) : null,
            'apagado_por_nome' => AtividadeCampo::temLixeira() && $a->apagado_por ? ($a->relationLoaded('apagador') ? $a->apagador : $a->apagador()->first(['id', 'nome']))?->nome : null,
            'updated_at' => $a->updated_at?->toIso8601String(),
        ];
    }
}
