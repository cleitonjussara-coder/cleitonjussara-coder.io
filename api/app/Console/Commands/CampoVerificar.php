<?php

namespace App\Console\Commands;

use App\Models\AtividadeCampo;
use App\Services\CampoAviso;
use App\Services\PushService;
use Carbon\Carbon;
use Illuminate\Console\Command;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Cache;

/**
 * php84 artisan campo:verificar
 *
 * Linha sugerida no crontab da Locaweb (a cada 30 min):
 *   0,30 * * * * /usr/bin/php84 /home/.../api-petermann/artisan campo:verificar
 *
 * Acompanhamento de trabalho solitário (11/11/2026, pedido do Cleiton): a atividade em campo serve para a empresa achar o
 * colaborador se ele passar mal dentro do campo. Quem iniciou um campo e está há muitas horas sem finalizar gera
 * aviso no celular, para alguém ligar e confirmar que está tudo bem.
 *
 * Quem recebe (decisão do Cleiton, 12/11/2026): com 3 h em campo sem finalizar (era 2h30 até 24/11/2026), UM aviso só, ao mesmo tempo para o
 * focal, o gestor e o admin. (Antes: focal com 4 h e gestor com 6 h.) Avisa uma vez por atividade (marca no cache por
 * 3 dias). Só olha início das últimas 24 h: campo esquecido aberto há dias não é emergência e viraria ruído. Quem está
 * em campo não recebe o aviso da gestão; recebe um lembrete próprio (24/11/2026): com 3 h e de novo a cada 2 h, até 24 h.
 */
class CampoVerificar extends Command
{
    private const TZ = 'America/Sao_Paulo';

    protected $signature = 'campo:verificar
        {--horas=3 : em campo há mais que isto, sem finalizar, avisa o focal e o gestor juntos}';

    protected $description = 'Acompanhamento de trabalho solitário: avisa o focal e o gestor juntos quando alguém está em campo há muito tempo';

    public function handle(PushService $push): int
    {
        $horas = max(0.5, (float) $this->option('horas'));
        $agora = Carbon::now(self::TZ);
        /* o banco guarda a hora de parede de Brasília: comparar com strings no mesmo formato */
        $limite = $agora->copy()->subMinutes((int) round($horas * 60))->format('Y-m-d H:i:s');
        $desde = $agora->copy()->subHours(24)->format('Y-m-d H:i:s');

        $abertas = AtividadeCampo::query()->vivos()->whereNull('fim')
            ->where('inicio', '<=', $limite)->where('inicio', '>=', $desde)
            ->with('colaborador:id,nome,email,ativo')->orderBy('inicio')->get()
            ->filter(fn (AtividadeCampo $a) => $a->colaborador && $a->colaborador->ativo);

        $avisos = 0;

        foreach ($abertas as $a) {
            $inicio = Carbon::parse($a->inicio->format('Y-m-d H:i:s'), self::TZ);
            $min = (int) $inicio->diffInMinutes($agora, true);
            $this->lembrar($push, $a, $inicio, $min);
            /* a marca "gestor" também vale: atividade que no sistema antigo só avisou o focal ainda avisa o gestor uma vez */
            if (Cache::has('campo-alerta-gestor-'.$a->id)) {
                continue;
            }
            /* focal + gestor + admin numa lista só: o aviso vai para todos ao mesmo tempo */
            $para = CampoAviso::destinatarios($a->user_id);
            $this->avisar($push, $a, $inicio, $min, $para);
            Cache::put('campo-alerta-'.$a->id, $agora->toIso8601String(), now()->addDays(3));
            Cache::put('campo-alerta-gestor-'.$a->id, $agora->toIso8601String(), now()->addDays(3));
            $avisos++;
        }

        $this->info($avisos ? $avisos.' aviso(s) de campo longo enviado(s).' : 'Nenhum aviso novo de campo longo.');

        return self::SUCCESS;
    }

    /* A própria pessoa (24/11/2026, caso Romário: saída de campo presa no celular e ninguém lembrava quem estava em campo).
       Tocar abre a tela do campo; o aviso também acorda o app e manda o registro que ficou guardado sem sinal. */
    private function lembrar(PushService $push, AtividadeCampo $a, Carbon $inicio, int $min): void
    {
        $chave = 'campo-lembrete-'.$a->id;
        if (Cache::has($chave)) {
            return;
        }
        Cache::put($chave, 1, now()->addMinutes(115));   // o cron roda a cada 30 min: repete a cada 2 h
        $m = $min % 60;
        $push->enviar($a->colaborador, '⏰ Você está em campo há '.intdiv($min, 60).'h'.($m ? sprintf('%02d', $m) : ''),
            "{$a->fazenda} · campo {$a->campo}, desde ".$inicio->format('H:i').'. Já saiu? Registre o fim das atividades. Se já registrou, abra o app com internet para enviar.',
            './?abrir=campo', 'campo-eu-'.$a->id);
    }

    private function avisar(PushService $push, AtividadeCampo $a, Carbon $inicio, int $min, Collection $destino): void
    {
        $m = $min % 60;
        $ha = intdiv($min, 60).'h'.($m ? sprintf('%02d', $m) : '');
        $nome = $a->colaborador->nome ?: $a->colaborador->email;
        $entregues = $destino->isEmpty() ? 0 : $push->enviar($destino,
            "⚠️ {$nome} em campo há {$ha}",
            "{$a->fazenda} · campo {$a->campo}, desde ".$inicio->format('H:i').'. Ainda sem fim registrado: ligue para confirmar se está tudo bem.',
            './?abrir=campo',
            CampoAviso::tag($a),   // a saída registrada usa a mesma tag e troca este aviso no celular
        );
        $this->line(sprintf('  %-28s %s · %s desde %s (%s) → %s: %d aparelho(s)',
            mb_substr($nome, 0, 28), $a->fazenda, $a->campo, $inicio->format('d/m H:i'), $ha,
            $destino->pluck('nome')->implode(', ') ?: 'ninguém', $entregues));
    }
}
