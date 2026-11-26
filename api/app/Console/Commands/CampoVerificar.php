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
 * Linha sugerida no crontab da Locaweb (a cada 10 min desde 26/11/2026; antes 30 min, e o aviso das 3 h chegava até 30 min
 * depois):
 *   0,10,20,30,40,50 * * * * /usr/bin/php84 /home/.../api-petermann/artisan campo:verificar
 *
 * Acompanhamento de trabalho solitário (11/11/2026, pedido do Cleiton): a atividade em campo serve para a empresa achar o
 * colaborador se ele passar mal dentro do campo. Quem iniciou um campo e está há muitas horas sem finalizar gera
 * aviso no celular, para alguém ligar e confirmar que está tudo bem.
 *
 * Quem recebe (decisão do Cleiton, 12/11/2026): com 3 h em campo sem finalizar (era 2h30 até 24/11/2026), UM aviso só, ao mesmo tempo para o
 * focal, o gestor e o admin. (Antes: focal com 4 h e gestor com 6 h.) Avisa uma vez por atividade (marca no cache por
 * 3 dias). Só olha início das últimas 24 h: campo esquecido aberto há dias não é emergência e viraria ruído. Quem está
 * em campo não recebe o aviso da gestão; recebe um lembrete próprio (24/11/2026): com 3 h e de novo a cada 2 h, até 24 h.
 *
 * 26/11/2026 (pedido do Cleiton): quem ligou toca "Liguei, está tudo bem" (verificado_em). Sem essa confirmação e ainda
 * sem saída 1 h depois do primeiro aviso, sai UM segundo aviso para os mesmos. Os dois avisos dizem quando o celular da
 * pessoa falou com o servidor pela última vez: a saída tocada sem sinal só chega quando o sinal volta.
 */
class CampoVerificar extends Command
{
    private const TZ = 'America/Sao_Paulo';

    protected $signature = 'campo:verificar
        {--horas=3 : em campo há mais que isto, sem finalizar, avisa o focal e o gestor juntos}
        {--segundo=60 : minutos depois do primeiro aviso, sem confirmação nem saída, para o segundo aviso}';

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
        $segundoMin = max(10, (int) $this->option('segundo'));
        $visto = CampoAviso::vistoEm($abertas->pluck('user_id')->unique());
        $temVerif = AtividadeCampo::temVerificacao();

        foreach ($abertas as $a) {
            $inicio = Carbon::parse($a->inicio->format('Y-m-d H:i:s'), self::TZ);
            $min = (int) $inicio->diffInMinutes($agora, true);
            $this->lembrar($push, $a, $inicio, $min);
            /* alguém já ligou e confirmou: nada mais para a gestão */
            if ($temVerif && $a->verificado_em) {
                continue;
            }
            $vistoTxt = CampoAviso::vistoTexto($visto->get($a->user_id));
            /* a marca "gestor" também vale: atividade que no sistema antigo só avisou o focal ainda avisa o gestor uma vez */
            if ($primeiro = Cache::get('campo-alerta-gestor-'.$a->id)) {
                if ($temVerif && ! Cache::has('campo-alerta2-'.$a->id) && $this->passou($primeiro, $agora, $segundoMin)) {
                    $this->avisar($push, $a, $inicio, $min, CampoAviso::destinatarios($a->user_id), $vistoTxt, true);
                    Cache::put('campo-alerta2-'.$a->id, $agora->toIso8601String(), now()->addDays(3));
                    $avisos++;
                }

                continue;
            }
            /* focal + gestor + admin numa lista só: o aviso vai para todos ao mesmo tempo */
            $para = CampoAviso::destinatarios($a->user_id);
            $this->avisar($push, $a, $inicio, $min, $para, $vistoTxt);
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

    /** O primeiro aviso saiu há pelo menos $min minutos? (marca antiga sem hora legível conta como "já passou") */
    private function passou(mixed $marca, Carbon $agora, int $min): bool
    {
        try {
            return Carbon::parse((string) $marca)->addMinutes($min)->lte($agora);
        } catch (\Throwable) {
            return true;
        }
    }

    private function avisar(PushService $push, AtividadeCampo $a, Carbon $inicio, int $min, Collection $destino, string $vistoTxt = '', bool $segundo = false): void
    {
        $m = $min % 60;
        $ha = intdiv($min, 60).'h'.($m ? sprintf('%02d', $m) : '');
        $nome = $a->colaborador->nome ?: $a->colaborador->email;
        $entregues = $destino->isEmpty() ? 0 : $push->enviar($destino,
            ($segundo ? "⚠️ Ainda sem resposta: {$nome} em campo há {$ha}" : "⚠️ {$nome} em campo há {$ha}"),
            "{$a->fazenda} · campo {$a->campo}, desde ".$inicio->format('H:i').'. Ainda sem fim registrado: ligue para confirmar se está tudo bem.'
                .$vistoTxt.($segundo ? ' Ninguém confirmou ainda: quem ligar, toque em "Liguei, está tudo bem".' : ''),
            './?abrir=campo',
            CampoAviso::tag($a),   // a saída registrada usa a mesma tag e troca este aviso no celular
        );
        $this->line(sprintf('  %s%-28s %s · %s desde %s (%s) → %s: %d aparelho(s)', $segundo ? '[2º] ' : '',
            mb_substr($nome, 0, 28), $a->fazenda, $a->campo, $inicio->format('d/m H:i'), $ha,
            $destino->pluck('nome')->implode(', ') ?: 'ninguém', $entregues));
    }
}
