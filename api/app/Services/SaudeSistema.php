<?php

namespace App\Services;

use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use RuntimeException;

/**
 * "Está tudo funcionando?" (06/11/2026): o cartão Saúde do sistema, no Perfil de
 * gestor e admin, junta num lugar só o que antes exigia abrir três cartões e o
 * painel da Locaweb. Roda só quando alguém abre o cartão (GET /admin/saude).
 *
 * Três regras guiam tudo aqui:
 *   • cada parte é lida sozinha: se uma falha, ela diz disponivel=false e as outras
 *     seguem. Parte que não deu para ler vira atenção, porque "tudo certo" tem que
 *     significar que olhamos, não que não conseguimos olhar;
 *   • nada de chamar o Google: o Drive sai do estado gravado, para o cartão abrir
 *     rápido e continuar abrindo com o Drive fora do ar;
 *   • nenhum segredo nem caminho do servidor no que sai daqui. O motivo real da
 *     falha vai para o log, nunca para a resposta.
 *
 * Não há como ler o crontab na hospedagem compartilhada: o atraso dos backups é
 * a evidência de que o Agendador de tarefas parou.
 */
class SaudeSistema
{
    /** Banco e fotos saem toda madrugada: 24 h de intervalo + 2 h de folga. */
    public const LIMITE_DIARIO_HORAS = 26;

    /** O completo sai todo domingo: 7 dias + 1 de folga, a mesma regra do cartão de backup. */
    public const LIMITE_COMPLETO_HORAS = 8 * 24;

    /** Pedaço lido do log por vez: linha gigante (stack trace, base64) não vira string gigante. */
    private const PEDACO_LOG = 8192;

    public function __construct(private BackupCompleto $backup, private DriveBackup $drive) {}

    public function medir(): array
    {
        $partes = [
            'backups' => [
                'banco' => $this->parte('backup do banco', fn () => $this->backupDiario(BackupCompleto::PREFIXO_BANCO)),
                'fotos' => $this->parte('backup das fotos', fn () => $this->backupFotos()),
                'completo' => $this->parte('backup completo', fn () => $this->backupCompleto()),
            ],
            'drive' => $this->parte('drive', fn () => $this->lerDrive()),
            'erros_hoje' => $this->parte('log', fn () => ['quantidade' => $this->errosDeHoje()]),
            'migracoes' => $this->parte('migrações', fn () => ['pendentes' => $this->migracoesPendentes()]),
            'movimento' => $this->parte('movimento', fn () => $this->lerMovimento()),
        ];

        $olhar = $this->oQueOlhar($partes);

        return [
            'gerado_em' => now(PontoCalculo::TZ)->toIso8601String(),
            'resumo' => ['estado' => $olhar === [] ? 'ok' : 'atencao', 'olhar' => $olhar],
        ] + $partes;
    }

    /**
     * Isola a falha de uma parte. Só a classe do erro vai para o log, em nível de aviso:
     * como erro, abrir o cartão aumentaria a própria contagem de erros de hoje. O try do
     * log existe porque a parte que falhou pode ser justamente a pasta de logs.
     */
    private function parte(string $nome, callable $ler): array
    {
        try {
            return ['disponivel' => true] + $ler();
        } catch (\Throwable $e) {
            try {
                Log::warning('saude: não consegui ler '.$nome.' ('.get_class($e).')');
            } catch (\Throwable) {
            }

            return ['disponivel' => false];
        }
    }

    /* ── backups ─────────────────────────────────────────────── */

    private function backupDiario(string $prefixo): array
    {
        $b = $this->backup->listar($prefixo)[0] ?? null;

        return $this->descrever($b, $this->atrasado($b, self::LIMITE_DIARIO_HORAS));
    }

    private function backupCompleto(): array
    {
        $b = $this->backup->listar()[0] ?? null;

        return $this->descrever($b, $this->atrasado($b, self::LIMITE_COMPLETO_HORAS));
    }

    /**
     * Dia sem foto nova não gera zip nenhum, de propósito (ver gerarFotos): zip velho
     * só é atraso se existe anexo sem cópia. Quem cobre o anexo é o mais novo entre o
     * fotos-*.zip e o completo, que leva todas as fotos: sem isso, a semana seguinte a
     * um domingo sem nada novo acusaria um atraso que não existe.
     *
     * Anexo sem cópia só é atraso depois de 26 h, o mesmo prazo do zip (06/11/2026): antes
     * disso a rodada das 02:45 que o pegaria pode nem ter chegado. Sem esse prazo, a primeira
     * foto depois de um fim de semana sem foto acendia "atrasado" com o cron funcionando.
     * Conta o anexo mais antigo, que é quem espera há mais tempo. Cron parado continua
     * aparecendo, 26 h depois do anexo; até lá o backup do banco já terá acusado.
     *
     * Sem zip nenhum dos dois, o que pesa é haver anexo. Por isso a mesma pergunta,
     * com referência zero, resolve esse caso.
     */
    private function backupFotos(): array
    {
        $b = $this->backup->listar(BackupCompleto::PREFIXO_FOTOS)[0] ?? null;
        $completo = $this->backup->listar()[0] ?? null;
        $referencia = max($b ? $this->quando($b) : 0, $completo ? $this->quando($completo) : 0);

        $fresco = $referencia > 0 && $this->idade($referencia) <= self::LIMITE_DIARIO_HORAS * 3600;
        $semCopia = $fresco ? null : $this->backup->anexoMaisAntigoDepoisDe($referencia);
        $atrasado = $semCopia !== null && $this->idade($semCopia) > self::LIMITE_DIARIO_HORAS * 3600;

        return $this->descrever($b, $atrasado) + [
            'sem_foto_nova' => ! $fresco && $semCopia === null,
            'aguardando_rodada' => $semCopia !== null && ! $atrasado,
        ];
    }

    private function descrever(?array $b, bool $atrasado): array
    {
        return [
            'estado' => $atrasado ? 'atrasado' : 'ok',
            'arquivo' => $b['nome'] ?? null,
            'em' => $b ? Carbon::createFromTimestamp($this->quando($b), PontoCalculo::TZ)->toIso8601String() : null,
            'bytes' => $b['bytes'] ?? null,
        ];
    }

    private function atrasado(?array $b, int $limiteHoras): bool
    {
        return $b === null || $this->idade($this->quando($b)) > $limiteHoras * 3600;
    }

    private function idade(int $quando): int
    {
        return now()->getTimestamp() - $quando;
    }

    /** A data sai do nome, como em gerarFotos e conferirDiario: copiar ou restaurar o zip muda o filemtime, e backup velho pareceria novo. */
    private function quando(array $b): int
    {
        $data = substr($b['nome'], strpos($b['nome'], '-') + 1, 15);

        return Carbon::createFromFormat('!Y-m-d-Hi', $data, BackupCompleto::TZ)->getTimestamp();
    }

    /* ── Drive ───────────────────────────────────────────────── */

    private function lerDrive(): array
    {
        $s = $this->drive->status();   // só lê drive-backup.json: nenhuma chamada ao Google

        return [
            'conectado' => (bool) $s['conectado'],
            'ultimo_envio' => [
                'banco' => $s['ultimo_envio_banco'] ?? null,
                'fotos' => $s['ultimo_envio_fotos'] ?? null,
                'completo' => $s['ultimo_envio'] ?? null,
            ],
            'ultimo_erro' => $s['ultimo_erro'] ? $this->semSegredo($s['ultimo_erro']) : null,
        ];
    }

    /**
     * O erro gravado é a mensagem crua da exceção: pode trazer o caminho do zip
     * ("Arquivo de backup não existe: /home/...") ou a URL do upload, que leva o id
     * da sessão. Corta isso e deixa o motivo, que é o que ajuda quem lê.
     */
    private function semSegredo(string $texto): string
    {
        /* as raízes conhecidas primeiro: elas podem ter espaço, que os padrões abaixo não atravessam */
        foreach ([base_path(), storage_path()] as $raiz) {
            foreach ([$raiz, str_replace('\\', '/', $raiz)] as $r) {
                $texto = (string) preg_replace('~'.preg_quote($r, '~').'\S*~', '[caminho]', $texto);
            }
        }

        /* preg_replace devolve null em UTF-8 inválido: aí sai o aviso fixo, nunca o texto cru */
        return preg_replace([
            '~https?://\S+~i',
            '~\b[A-Za-z]:[\\\\/]\S*~',
            '~(?<![\w.:/])/(?:[\w.@+-]+/)*[\w.@+-]+~u',
            '~[A-Za-z0-9._-]{32,}~',
        ], ['[endereço]', '[caminho]', '[caminho]', '[oculto]'], $texto) ?? 'Erro registrado, detalhe oculto.';
    }

    /* ── log ─────────────────────────────────────────────────── */

    /**
     * Linhas ERROR/CRITICAL do dia de Brasília. Só a quantidade: o texto do log tem
     * dados de nota, caminhos e stack trace, e não sai daqui.
     *
     * O servidor é UTC, e nome do arquivo e hora da linha seguem esse fuso. Depois das
     * 21h de Brasília já é o arquivo de amanhã; olhar só o de hoje faria a contagem zerar
     * à noite, e o de amanhã sozinho perderia a manhã. Por isso lê os arquivos que a janela
     * alcança e corta pela hora da linha. Sem arquivo é dia sem erro: o canal só cria o
     * log no primeiro registro.
     */
    private function errosDeHoje(): int
    {
        $tz = date_default_timezone_get();
        $inicio = now(PontoCalculo::TZ)->startOfDay()->setTimezone($tz);
        $corte = $inicio->format('Y-m-d H:i:s');

        $total = 0;
        foreach (array_unique([$inicio->format('Y-m-d'), now($tz)->format('Y-m-d')]) as $dia) {
            $total += $this->contarErros(storage_path('logs/laravel-'.$dia.'.log'), $corte);
        }

        return $total;
    }

    /**
     * Lê em pedaços: memória fixa, por maior que o arquivo esteja. Só o começo de linha
     * conta, assim stack trace e texto colado na mensagem não viram erro a mais.
     */
    private function contarErros(string $arquivo, string $corte): int
    {
        if (! file_exists($arquivo)) {
            return 0;
        }
        $h = is_file($arquivo) ? @fopen($arquivo, 'rb') : false;
        if ($h === false) {
            throw new RuntimeException('Não consegui abrir o log');
        }

        $n = 0;
        $comecoDeLinha = true;
        try {
            while (($pedaco = fgets($h, self::PEDACO_LOG)) !== false) {
                if ($comecoDeLinha
                    && preg_match('/^\[(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})[^\]]*\] \S+[.](?:ERROR|CRITICAL):/', $pedaco, $m)
                    && $m[1].' '.$m[2] >= $corte) {
                    $n++;
                }
                $comecoDeLinha = str_ends_with($pedaco, "\n");
            }
        } finally {
            fclose($h);
        }

        return $n;
    }

    /* ── migrações ───────────────────────────────────────────── */

    /**
     * Pergunta direto ao Migrator, sem interpretar o texto do migrate:status: sem a tabela
     * de migrações aquele texto não tem nenhum "Pending" e o cartão diria que está em dia.
     */
    private function migracoesPendentes(): array
    {
        $m = app('migrator');
        if (! $m->repositoryExists()) {
            throw new RuntimeException('Tabela de migrações não existe');
        }
        $arquivos = $m->getMigrationFiles(array_merge($m->paths(), [database_path('migrations')]));

        return array_values(array_diff(array_keys($arquivos), $m->getRepository()->getRan()));
    }

    /* ── movimento ───────────────────────────────────────────── */

    /**
     * Usa updated_at porque é o relógio do servidor. O created_at vem do aparelho no
     * primeiro envio: nota que ficou três dias na fila entraria como se fosse de três
     * dias atrás, e é justo a fila parada que este número quer mostrar. O custo é contar
     * também a nota corrigida, e o rótulo do cartão diz isso.
     */
    private function lerMovimento(): array
    {
        $vivas = DB::table('notas')->where('deleted', false);
        $ultima = (clone $vivas)->max('updated_at');

        return [
            'ultima_em' => $ultima ? Carbon::parse($ultima, 'UTC')->setTimezone(PontoCalculo::TZ)->toIso8601String() : null,
            'ultimas_24h' => (clone $vivas)->where('updated_at', '>=', now()->utc()->subDay())->count(),
        ];
    }

    /* ── resumo ──────────────────────────────────────────────── */

    /**
     * Movimento baixo não entra aqui: domingo sem nota é normal, e o servidor não tem
     * como saber se há nota parada em aparelho. Fica à vista, para quem lê julgar.
     */
    private function oQueOlhar(array $p): array
    {
        $olhar = [];
        $agendador = 'Confira o Agendador de tarefas da Locaweb.';

        foreach (['banco' => 'do banco', 'fotos' => 'das fotos', 'completo' => 'completo'] as $tipo => $nome) {
            $b = $p['backups'][$tipo];
            if (! $b['disponivel']) {
                $olhar[] = "Não consegui ler o backup {$nome}.";
            } elseif ($b['estado'] === 'atrasado') {
                $olhar[] = ($b['arquivo'] ? "Backup {$nome} atrasado." : "Nenhum backup {$nome} na pasta.").' '.$agendador;
            }
        }

        $d = $p['drive'];
        if (! $d['disponivel']) {
            $olhar[] = 'Não consegui ler a situação do Google Drive.';
        } else {
            if (! $d['conectado']) {
                $olhar[] = 'Cópia no Google Drive desligada: conecte em Perfil → Backup.';
            }
            if ($d['ultimo_erro']) {
                $olhar[] = 'O envio ao Google Drive registrou erro.';
            }
        }

        $e = $p['erros_hoje'];
        if (! $e['disponivel']) {
            $olhar[] = 'Não consegui ler o log de hoje.';
        } elseif ($e['quantidade'] > 0) {
            $olhar[] = $e['quantidade'] === 1 ? '1 erro no log de hoje.' : "{$e['quantidade']} erros no log de hoje.";
        }

        $m = $p['migracoes'];
        if (! $m['disponivel']) {
            $olhar[] = 'Não consegui conferir as migrações do banco.';
        } elseif ($m['pendentes'] !== []) {
            $n = count($m['pendentes']);
            $olhar[] = ($n === 1 ? '1 migração pendente' : "{$n} migrações pendentes").': use "Atualizar estrutura do banco".';
        }

        if (! $p['movimento']['disponivel']) {
            $olhar[] = 'Não consegui ler o movimento de notas.';
        }

        return $olhar;
    }
}
