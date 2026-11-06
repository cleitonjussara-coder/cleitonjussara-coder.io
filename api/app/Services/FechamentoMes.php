<?php

namespace App\Services;

use App\Models\Colaborador;
use App\Models\MesFechado;
use App\Models\MesFechadoHistorico;
use App\Models\Nota;
use App\Models\Repasse;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * Fechamento de mês (06/11/2026, decisão do dono): protege a planilha entregue à contabilidade sem travar a fila de quem está
 * em campo. É o ÚNICO lugar que decide se uma data está fechada; nota, repasse e colaborador perguntam aqui.
 *
 *   nota NOVA com data de mês fechado → entra, marcada, e a gestão confere (ver notaEntrouFora).
 *   nota ou repasse EXISTENTE de mês fechado → 423 para todos, gestor inclusive, até reabrir.
 *   nota que aguarda conferência → fica fora dos relatórios enquanto o mês estiver fechado, com aviso no arquivo (Nota::noRelatorio).
 *
 * Sem a tabela (API publicada antes da migração) nada está fechado e tudo funciona como antes.
 */
class FechamentoMes
{
    private const NOMES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

    /* Um aviso por janela, com a contagem do que está pendente: uma fila que descarrega 30 notas não toca o celular 30 vezes. */
    private const CHAVE_AVISO = 'fechamento-aviso-fora';

    private const JANELA_AVISO_MIN = 60;

    private const TRAVA_AVISO_SEG = 30;

    private const MESES_NA_LISTA = 12;

    private const LIMITE_LISTA = 200;

    public function __construct(private PushService $push, private HistoricoNota $historico) {}

    public function ativo(): bool
    {
        return MesFechado::tabelaExiste();
    }

    public function mesFechado(int $ano, int $mes): bool
    {
        return $this->ativo() && MesFechado::where('ano', $ano)->where('mes', $mes)->exists();
    }

    /** A data cai num mês fechado? Aceita 'aaaa-mm-dd' ou data do Carbon. */
    public function dataFechada(mixed $data): bool
    {
        $p = self::periodoDaData($data);

        return $p !== null && $this->mesFechado($p[0], $p[1]);
    }

    /**
     * O período fechado que segura este registro, ou null. Olha a data e também mes/ano gravados (as planilhas filtram por eles, e
     * registro antigo pode ter mês diferente da data) e a data nova do PUT: mover para dentro de um mês fechado mexe nele tanto
     * quanto mover para fora. Devolve [ano, mes].
     */
    public function periodoTravado(Nota|Repasse $r, ?string $dataNova = null): ?array
    {
        if (! $this->ativo()) {
            return null;
        }
        $candidatos = [self::periodoDaData($r->data), [(int) $r->ano, (int) $r->mes], self::periodoDaData($dataNova)];
        foreach ($candidatos as $p) {
            if ($p !== null && $this->mesFechado($p[0], $p[1])) {
                return $p;
            }
        }

        return null;
    }

    /** O 423: diz o motivo e devolve a versão atual, que é o que a fila do app grava para soltar o item. */
    public function recusa(Nota|Repasse $r, array $periodo, Colaborador $u): JsonResponse
    {
        [$ano, $mes] = $periodo;
        $rotulo = self::rotulo($ano, $mes);
        $ehNota = $r instanceof Nota;
        $oque = $ehNota ? 'na nota '.$this->tituloDaNota($r) : 'neste repasse';
        Log::warning('alteração recusada: mês fechado', ['registro' => $r->id, 'mes' => "{$mes}/{$ano}", 'por' => $u->email]);

        return response()->json([
            'message' => $u->gerencia()
                ? "O mês de {$rotulo} está fechado. Para alterar, reabra o mês em Equipe, no quadro Fechamento de mês."
                : "O mês de {$rotulo} foi fechado pela gestão. Sua alteração {$oque} não foi gravada; fale com o gestor.",
            'mes_fechado' => true,
            'ano' => $ano,
            'mes' => $mes,
            'mes_rotulo' => $rotulo,
            ($ehNota ? 'nota' : 'repasse') => $r,
        ], 423);
    }

    /** Repasse que ainda não existe: não há versão atual para devolver, e quem lança é o gestor, que pode reabrir. */
    public function recusaRepasseNovo(string $data, Colaborador $u): JsonResponse
    {
        [$ano, $mes] = self::periodoDaData($data);
        $rotulo = self::rotulo($ano, $mes);
        Log::warning('repasse novo recusado: mês fechado', ['mes' => "{$mes}/{$ano}", 'por' => $u->email]);

        return response()->json([
            'message' => "O mês de {$rotulo} está fechado. Para lançar este repasse nele, reabra o mês em Equipe, no quadro Fechamento de mês.",
            'mes_fechado' => true,
            'ano' => $ano,
            'mes' => $mes,
            'mes_rotulo' => $rotulo,
            'repasse' => null,
        ], 423);
    }

    /** Meses fechados em que a pessoa tem nota ou repasse vivos, do mais antigo para o mais novo. */
    public function mesesComRegistrosDe(string $userId): array
    {
        if (! $this->ativo()) {
            return [];
        }
        $fechados = MesFechado::get(['ano', 'mes'])->map(fn ($m) => $m->ano * 100 + $m->mes)->all();
        if ($fechados === []) {
            return [];
        }
        $periodos = fn ($q) => $q->where('user_id', $userId)->where('deleted', false)->selectRaw('ano * 100 + mes AS p')->distinct()->pluck('p')->map(fn ($p) => (int) $p)->all();
        $deles = array_unique(array_merge($periodos(Nota::query()), $periodos(Repasse::query())));
        $travados = array_values(array_intersect($fechados, $deles));
        sort($travados);

        return array_map(fn ($p) => ['ano' => intdiv($p, 100), 'mes' => $p % 100, 'rotulo' => self::rotulo(intdiv($p, 100), $p % 100)], $travados);
    }

    /** O mês já terminou? O mês corrente e os futuros ainda recebem lançamento normal, então não fecham. */
    public function podeFechar(int $ano, int $mes): bool
    {
        $agora = Carbon::now(PontoCalculo::TZ);

        return $ano * 12 + $mes < (int) $agora->format('Y') * 12 + (int) $agora->format('n');
    }

    /** Fecha. Fechar o que já está fechado não muda nada nem grava histórico. Devolve se já estava. */
    public function fechar(int $ano, int $mes, Colaborador $u): bool
    {
        return DB::transaction(function () use ($ano, $mes, $u) {
            $novo = DB::table('meses_fechados')->insertOrIgnore(['ano' => $ano, 'mes' => $mes, 'fechado_em' => now(), 'fechado_por' => $u->id]);
            if ($novo === 0) {
                return true;
            }
            $this->registrar($ano, $mes, 'fechar', null, $u);

            return false;
        });
    }

    /** Reabre. Reabrir o que está aberto não grava histórico: toque duplo não vira dois registros. Devolve se já estava aberto. */
    public function reabrir(int $ano, int $mes, string $motivo, Colaborador $u): bool
    {
        return DB::transaction(function () use ($ano, $mes, $motivo, $u) {
            if (MesFechado::where('ano', $ano)->where('mes', $mes)->delete() === 0) {
                return true;
            }
            $this->registrar($ano, $mes, 'reabrir', $motivo, $u);

            return false;
        });
    }

    /**
     * Nota nova acabou de entrar com data de mês fechado. Nada aqui derruba o lançamento: ele já está gravado, e o colaborador em
     * campo não pode ficar com o item preso por causa de um aviso.
     */
    public function notaEntrouFora(Nota $n, Colaborador $autor): void
    {
        try {
            $this->historico->registrarFechamento($n->id, 'fora_fechamento', $autor, 'chegou depois do fechamento de '.self::rotulo((int) $n->ano, (int) $n->mes));
            $this->avisarPendentes();
        } catch (\Throwable $e) {
            Log::warning('aviso de nota fora do fechamento falhou', ['nota' => $n->id, 'erro' => $e->getMessage()]);
        }
    }

    /**
     * Um push para todas as notas que ainda não saíram em aviso, se a janela já passou. Chamado quando a nota entra e pelo
     * fechamento:avisar, que cobre a nota que chegou dentro da janela e não teve outra depois dela.
     *
     * 06/11/2026: a janela era um Cache::add feito antes de saber se havia para quem avisar. O gestor que lançava a própria nota
     * gastava a hora com lista vazia e a nota seguinte, de colaborador, não tocava ninguém. Agora a janela é a hora do último aviso
     * que chegou a um aparelho, gravada na nota: sem destinatário ou sem entrega nada é marcado, e a próxima tentativa vale.
     * Devolve quantas notas o aviso cobriu.
     */
    public function avisarPendentes(): int
    {
        if (! Nota::temForaFechamento()) {
            return 0;
        }

        /* duas notas ao mesmo tempo não viram dois pushes; a que perde a trava fica sem aviso e entra no próximo */
        return (int) Cache::lock(self::CHAVE_AVISO, self::TRAVA_AVISO_SEG)->get(function () {
            $ultimo = Nota::max('fora_avisada_em');
            if ($ultimo !== null && Carbon::parse($ultimo)->gt(now()->subMinutes(self::JANELA_AVISO_MIN))) {
                return 0;
            }
            $novas = $this->foraPendentes()->whereNull('fora_avisada_em')->get(['id', 'ano', 'mes', 'created_by']);
            if ($novas->isEmpty()) {
                return 0;
            }
            $gestores = $this->destinatarios($novas);
            if ($gestores->isEmpty()) {
                return 0;
            }
            $pendentes = $this->foraPendentes()->count();
            $resumo = $pendentes === 1 ? '1 nota aguarda conferência' : "{$pendentes} notas aguardam conferência";
            $meses = $novas->map(fn ($n) => self::rotulo((int) $n->ano, (int) $n->mes))->unique()->implode(', ');
            $entregues = $this->push->enviar($gestores, 'Nota em mês fechado', "Chegou nota de mês já fechado ({$meses}). {$resumo} em Equipe, Fechamento de mês.", './?abrir=fechamento', 'fora-fechamento');
            if ($entregues === 0) {
                return 0;
            }
            /* toBase: pelo Eloquent o update carimbaria updated_at, e avisar a gestão não é editar a nota (ver conferir) */
            Nota::whereIn('id', $novas->pluck('id'))->toBase()->update(['fora_avisada_em' => now()]);

            return $novas->count();
        });
    }

    /* Quem lançou não precisa do próprio aviso, mas só quando o lote é todo dele: nota de outra pessoa no mesmo lote é novidade. */
    private function destinatarios(\Illuminate\Support\Collection $novas): \Illuminate\Support\Collection
    {
        $autores = $novas->pluck('created_by')->unique();
        $gestores = Colaborador::whereIn('role', ['gestor', 'admin'])->where('ativo', true)->get();
        if ($autores->count() === 1) {
            $gestores = $gestores->where('id', '<>', $autores->first())->values();
        }
        /* mesma regra do aviso de foto em branco: a homologação é cópia da produção, com inscrições de gente de verdade */
        if (app()->environment('staging')) {
            $gestores = $gestores->filter(fn ($c) => str_ends_with(strtolower((string) $c->email), '@homolog.local'))->values();
        }

        return $gestores;
    }

    /** Não mexe no updated_at nem no updated_by: conferir não é editar, e não pode virar conflito no aparelho do dono. */
    public function conferir(Nota $n, Colaborador $u): void
    {
        if ($n->fora_conferida_em !== null) {
            return;
        }
        $n->timestamps = false;
        $n->forceFill(['fora_conferida_em' => now(), 'fora_conferida_por' => $u->id])->save();
        $this->historico->registrarFechamento($n->id, 'conferida', $u, 'conferida depois do fechamento');
    }

    /**
     * As notas que os relatórios deixam de fora agora, para o Excel do app fazer a mesma conta da planilha e a ficha avisar. O app
     * pergunta aqui e não olha os campos da própria nota: conferir não muda o updated_at, então a cópia do aparelho fica velha.
     */
    public function aguardando(Colaborador $u): array
    {
        return Nota::query()->aguardandoConferencia()->visiveisPara($u)->orderBy('data')
            ->get(['id', 'user_id', 'ano', 'mes', 'valor', 'tipo', 'pagamento'])->all();
    }

    /** O que a tela mostra. Quem não vê a equipe recebe só quais meses estão fechados: é o que o formulário dele precisa. */
    public function painel(Colaborador $u): array
    {
        if (! $this->ativo()) {
            return ['disponivel' => false, 'fechados' => [], 'meses' => [], 'historico' => [], 'fora' => [], 'pode_alterar' => false];
        }
        $linhas = MesFechado::orderByDesc('ano')->orderByDesc('mes')->get();
        $fechados = $linhas->map(fn ($m) => ['ano' => $m->ano, 'mes' => $m->mes])->values()->all();
        if (! $u->veTudo()) {
            return ['disponivel' => true, 'fechados' => $fechados];
        }

        $historico = MesFechadoHistorico::orderByDesc('feito_em')->orderByDesc('id')->limit(self::LIMITE_LISTA)->get();
        $fora = Nota::temForaFechamento() ? $this->foraPendentes()->orderByDesc('fora_fechamento_em')->limit(self::LIMITE_LISTA)->get() : collect();
        $ids = $linhas->pluck('fechado_por')->merge($historico->pluck('feito_por'))->merge($fora->pluck('user_id'))->filter()->unique()->values()->all();
        $nomes = Colaborador::whereIn('id', $ids)->get(['id', 'nome', 'email'])->mapWithKeys(fn ($c) => [$c->id => $c->nome ?: $c->email])->all();
        $nome = fn (?string $id) => $id === null ? null : ($nomes[$id] ?? 'Colaborador excluído');

        return [
            'disponivel' => true,
            'fechados' => $fechados,
            'pode_alterar' => $u->gerencia(),
            'meses' => $this->meses($linhas, $nome),
            'historico' => $historico->map(fn ($h) => [
                'id' => $h->id, 'ano' => $h->ano, 'mes' => $h->mes, 'rotulo' => self::rotulo($h->ano, $h->mes),
                'acao' => $h->acao, 'motivo' => $h->motivo, 'feito_em' => $h->feito_em?->toISOString(), 'por_nome' => $nome($h->feito_por) ?? 'Sistema',
            ])->values()->all(),
            'fora' => $fora->map(fn (Nota $n) => [
                'id' => $n->id, 'data' => $n->data?->format('Y-m-d'), 'ano' => $n->ano, 'mes' => $n->mes, 'rotulo' => self::rotulo((int) $n->ano, (int) $n->mes),
                'valor' => (float) $n->valor, 'razao_social' => $n->razao_social, 'tipo' => $n->tipo, 'subtipo' => $n->subtipo,
                'dono_nome' => $n->user_id === null ? 'Sem colaborador' : $nome($n->user_id), 'chegou_em' => $n->fora_fechamento_em ? Carbon::parse($n->fora_fechamento_em)->toISOString() : null,
                /* com o mês reaberto a nota segue a conferir, mas já sai na planilha (ver Nota::noRelatorio): a lista diz qual é o caso */
                'fora_da_planilha' => $linhas->contains(fn ($m) => $m->ano === (int) $n->ano && $m->mes === (int) $n->mes),
            ])->values()->all(),
        ];
    }

    public static function rotulo(int $ano, int $mes): string
    {
        return (self::NOMES[$mes - 1] ?? (string) $mes).'/'.$ano;
    }

    /** [ano, mes] de uma data, ou null. */
    private static function periodoDaData(mixed $data): ?array
    {
        $texto = $data instanceof \DateTimeInterface ? $data->format('Y-m-d') : (string) $data;

        return preg_match('/^(\d{4})-(\d{2})/', $texto, $m) ? [(int) $m[1], (int) $m[2]] : null;
    }

    private function tituloDaNota(Nota $n): string
    {
        return trim((string) ($n->razao_social ?: $n->numero)) ?: 'sem nome';
    }

    private function foraPendentes(): \Illuminate\Database\Eloquent\Builder
    {
        return Nota::query()->whereNotNull('fora_fechamento_em')->whereNull('fora_conferida_em')->where('deleted', false);
    }

    /* Mês corrente, os 12 anteriores e qualquer fechado mais antigo. Do mais novo para o mais velho. */
    private function meses(\Illuminate\Support\Collection $linhas, callable $nome): array
    {
        $agora = Carbon::now(PontoCalculo::TZ);
        $porPeriodo = $linhas->keyBy(fn ($m) => $m->ano * 100 + $m->mes);
        $periodos = $porPeriodo->keys()->all();
        for ($i = 0; $i <= self::MESES_NA_LISTA; $i++) {
            $d = $agora->copy()->startOfMonth()->subMonthsNoOverflow($i);
            $periodos[] = (int) $d->format('Y') * 100 + (int) $d->format('n');
        }
        $periodos = array_unique($periodos);
        rsort($periodos);

        $foraPorMes = Nota::temForaFechamento()
            ? $this->foraPendentes()->selectRaw('ano * 100 + mes AS p, COUNT(*) AS q')->groupBy('p')->pluck('q', 'p')->all()
            : [];

        return array_map(function ($p) use ($porPeriodo, $foraPorMes, $nome) {
            [$ano, $mes] = [intdiv($p, 100), $p % 100];
            $linha = $porPeriodo->get($p);

            return [
                'ano' => $ano, 'mes' => $mes, 'rotulo' => self::rotulo($ano, $mes),
                'fechado' => $linha !== null,
                'fechado_em' => $linha?->fechado_em?->toISOString(),
                'fechado_por' => $linha ? ($nome($linha->fechado_por) ?? 'Sistema') : null,
                'pode_fechar' => $linha === null && $this->podeFechar($ano, $mes),
                'fora' => (int) ($foraPorMes[$p] ?? 0),
            ];
        }, $periodos);
    }

    private function registrar(int $ano, int $mes, string $acao, ?string $motivo, Colaborador $u): void
    {
        MesFechadoHistorico::create([
            'ano' => $ano, 'mes' => $mes, 'acao' => $acao, 'motivo' => $motivo,
            'feito_por' => $u->id, 'feito_papel' => $u->role, 'feito_em' => now(),
        ]);
    }
}
