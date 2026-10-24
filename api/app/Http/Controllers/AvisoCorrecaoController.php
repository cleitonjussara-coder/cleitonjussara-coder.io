<?php

namespace App\Http\Controllers;

use App\Models\AvisoCorrecao;
use App\Models\Colaborador;
use App\Models\Nota;
use App\Services\AvisoCorrecaoAviso;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;

/**
 * Aviso para corrigir nota (24/10/2026, pedido do Cleiton).
 *
 *   gestor/admin  → avisa o dono de uma nota do quadro "O que falta corrigir" (POST /avisos-correcao) e vê, por nota,
 *                   se já foi avisado e quando (GET /avisos-correcao?nota_ids=);
 *   colaborador   → só enxerga e dispensa o que é DELE (404 no dos outros);
 *   contador      → nada (o SomenteLeitura fecha o módulo).
 *
 * Freios (config petermann.aviso_correcao): uma nota só é avisada de novo depois de um intervalo mínimo (12 h), mesmo
 * que o primeiro aviso já tenha sido dispensado; e vários avisos ao MESMO colaborador em poucos minutos viram um só
 * celular/e-mail (os demais entram só no sino — ver AvisoCorrecaoAviso). Só se avisa o dono, e só se ele tem papel de colaborador,
 * está ativo e já foi liberado — gestor/admin não são avisados (corrigem direto) e nota sem dono não tem a quem avisar.
 */
class AvisoCorrecaoController extends Controller
{
    public function __construct(private AvisoCorrecaoAviso $aviso) {}

    /** GET /avisos-correcao?nota_ids=a,b,c — o último aviso de cada nota pedida. Só gestor/admin. */
    public function index(Request $r): JsonResponse
    {
        abort_unless($r->user()->gerencia(), 403, 'Só gestor ou administrador vê os avisos de correção');
        if (! AvisoCorrecao::tabelaExiste()) {
            return response()->json([]);   // API publicada antes da migração: o quadro segue sem o "Avisado"
        }
        $ids = array_values(array_unique(array_filter(array_map('trim', explode(',', (string) $r->query('nota_ids', ''))))));
        $ids = array_slice($ids, 0, 200);
        if (! $ids) {
            return response()->json([]);
        }

        $avisos = AvisoCorrecao::with(['colaborador:id,nome', 'autor:id,nome'])
            ->whereIn('nota_id', $ids)->orderByDesc('created_at')->get()
            ->unique('nota_id')->values();

        return response()->json($avisos->map->paraApp()->values());
    }

    /**
     * GET /avisos-correcao/sino — o que cabe no sino do colaborador: os avisos abertos para ELE (dos últimos 30 dias)
     * cuja nota ainda existe, não está na lixeira e continua sendo dele. Gestor/admin não recebem aviso: lista vazia.
     */
    public function sino(Request $r): JsonResponse
    {
        $u = $r->user();
        if (! AvisoCorrecao::tabelaExiste() || $u->gerencia() || $u->soLeitura()) {
            return response()->json([]);
        }
        $q = AvisoCorrecao::with(['colaborador:id,nome', 'autor:id,nome'])
            ->where('colaborador_id', $u->id)->whereNull('visto_em')
            ->where('created_at', '>=', now()->subDays(30))
            ->whereHas('nota', fn ($n) => $n->where('deleted', false)->whereColumn('notas.user_id', 'avisos_correcao.colaborador_id'));

        /* os 50 MAIS NOVOS (se passar disso, o corte é nos antigos), em ordem cronológica */
        return response()->json($q->orderByDesc('created_at')->limit(50)->get()->reverse()->map->paraApp()->values());
    }

    /** POST /avisos-correcao — {nota_id, motivos[], mensagem?}. Só gestor/admin. */
    public function store(Request $r): JsonResponse
    {
        $u = $r->user();
        $this->exigeTabela();
        abort_unless($u->gerencia(), 403, 'Só gestor ou administrador avisa para corrigir uma nota');
        $d = $r->validate([
            'nota_id' => ['required', 'string', 'max:64'],
            'motivos' => ['required', 'array', 'min:1', 'max:8'],
            'motivos.*' => ['required', 'string', 'max:60'],
            'mensagem' => ['nullable', 'string', 'max:500'],
        ], [
            'motivos.required' => 'Diga o que falta corrigir na nota.',
            'motivos.min' => 'Diga o que falta corrigir na nota.',
            'motivos.max' => 'São motivos demais — use a mensagem para explicar.',
            'motivos.*.max' => 'Um dos motivos passou de 60 letras.',
            'mensagem.max' => 'A mensagem passou de 500 letras.',
        ]);

        $nota = Nota::find($d['nota_id']);
        abort_unless($nota, 404, 'Nota não encontrada');
        abort_if($nota->deleted, 422, 'Esta nota está na lixeira — não há o que corrigir.');
        abort_if($nota->user_id === null, 422, 'Nota de Faturamento sem colaborador não tem a quem avisar.');
        $alvo = Colaborador::find($nota->user_id);
        abort_unless($alvo, 404, 'O dono da nota não foi encontrado');
        abort_if($alvo->id === $u->id, 422, 'A nota é sua: corrija direto.');
        abort_unless($alvo->role === 'colaborador', 422, 'Só se avisa colaborador (gestor e administrador corrigem a própria nota direto).');
        abort_unless($alvo->ativo, 422, "{$alvo->nome} está desativado");
        abort_unless($alvo->confirmado(), 422, "{$alvo->nome} ainda não foi liberado para usar o app");

        /* freio: intervalo mínimo desde o último aviso desta nota (dispensado ou não) */
        $horas = max(0, (int) config('petermann.aviso_correcao.intervalo_horas', 12));
        $ultimo = AvisoCorrecao::where('nota_id', $nota->id)->latest('created_at')->first();
        if ($horas > 0 && $ultimo && $ultimo->created_at->copy()->addHours($horas)->isFuture()) {
            $libera = $ultimo->created_at->copy()->addHours($horas);
            abort(422, "{$alvo->nome} já recebeu o aviso desta nota em ".$this->quando($ultimo->created_at)." — para não incomodar, um novo aviso só sai depois de {$horas} h (a partir de ".$this->quando($libera).').');
        }

        $a = AvisoCorrecao::create([
            'nota_id' => $nota->id,
            'colaborador_id' => $alvo->id,
            'pedido_por' => $u->id,
            'motivos' => array_values(array_map(fn ($m) => trim($m), $d['motivos'])),
            'mensagem' => isset($d['mensagem']) ? (trim($d['mensagem']) ?: null) : null,
            'nota_titulo' => mb_substr((string) ($nota->razao_social ?: ($nota->cnpj ?: 'Sem empresa')), 0, 160),
            'nota_data' => $nota->data?->format('Y-m-d'),
            'nota_valor' => $nota->valor,
        ]);
        $this->aviso->enviar($a);

        return response()->json($a->fresh(['colaborador', 'autor'])->paraApp(), 201);
    }

    /**
     * PATCH /avisos-correcao/{id}/visto — o colaborador deu "OK, vi". Só o dono do aviso. Vale para TODOS os avisos
     * ainda abertos da mesma nota dele (a nota pode ter sido avisada mais de uma vez): um OK, vi tira todos do sino.
     */
    public function visto(Request $r, string $id): JsonResponse
    {
        $this->exigeTabela();
        $u = $r->user();
        $a = AvisoCorrecao::where('colaborador_id', $u->id)->find($id);
        abort_unless($a, 404, 'Aviso não encontrado');   // de outra pessoa = não existe (nada de 403 que confirme o id)
        AvisoCorrecao::where('colaborador_id', $u->id)->where('nota_id', $a->nota_id)->whereNull('visto_em')->update(['visto_em' => now()]);

        return response()->json($a->fresh(['colaborador', 'autor'])->paraApp());
    }

    /** Janela entre publicar a API e rodar a migração: responde 503 claro (não 500 com e-mail de alerta ao dono). */
    private function exigeTabela(): void
    {
        abort_unless(AvisoCorrecao::tabelaExiste(), 503, 'O servidor ainda está atualizando o banco de dados — tente de novo em alguns minutos.');
    }

    /** "19/10 às 14:30" no horário de Brasília (o servidor roda em UTC). */
    private function quando(Carbon $t): string
    {
        $br = $t->copy()->setTimezone('America/Sao_Paulo');

        return $br->format('d/m').' às '.$br->format('H:i');
    }
}
