<?php

namespace App\Services;

use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use RuntimeException;
use ZipArchive;

/**
 * Backup completo = banco (cópia íntegra por VACUUM INTO) + todas as fotos,
 * num único .zip em storage/app/backups (fora do public_html).
 *
 * Quem chama:
 *   • `php84 artisan backup:gerar` — agendado no painel da Locaweb
 *     (Agendador de tarefas), 1x por semana; mantém as N últimas cópias;
 *   • GET /backup/completo — o admin gera e baixa na hora pelo Perfil.
 *
 * Miniaturas (<user>/mini/) ficam de fora: são regeradas sozinhas.
 * Fotos entram sem compressão (jpg não encolhe; STORE é instantâneo).
 *
 * Backup diário (03/11/2026): `backup:gerar --so-banco` gera banco-*.zip só
 * com o banco, na mesma pasta. Cada tipo tem a sua rotação e o prefixo é o que
 * separa: listar, podar e paraApagar nunca misturam. A tela do app e o "Enviar
 * agora" seguem vendo só os completos.
 *
 * Backup diário das fotos (05/11/2026): `backup:gerar --fotos-novas` gera
 * fotos-*.zip com tudo o que mudou desde o último completo ou difere do que ele
 * guardou, porque nota nova ficava até 7 dias sem cópia do anexo. Cada zip é
 * autossuficiente, sem corrente de incrementais: restaurar = último completo +
 * último fotos.
 */
class BackupCompleto
{
    public const PASTA = 'backups';

    public const TZ = PontoCalculo::TZ;   // nome do arquivo na hora do Brasil

    public const PREFIXO_COMPLETO = 'petermann';

    public const PREFIXO_BANCO = 'banco';

    public const PREFIXO_FOTOS = 'fotos';

    /**
     * Folga do corte das fotos novas (05/11/2026). O nome do completo tem a hora em
     * que ele COMEÇOU: o que entrou enquanto ele rodava pode não estar lá dentro.
     */
    private const FOLGA_FOTOS_DIAS = 1;

    /** Zip guarda a hora em passos de 2 s (05/11/2026): sem esta folga, todo anexo pareceria alterado. */
    private const FOLGA_DATA_ZIP_SEG = 2;

    /** Anexo trocado no meio da montagem refaz o zip (05/11/2026); mais que isto já é falha a avisar. */
    private const TENTATIVAS_FOTOS = 3;

    /** Mesmo prefixo de FotoStorage::TMP_PREFIXO, que é privado. */
    private const TMP_PREFIXO = '.tmp-';

    /** O nome é de um backup deste tipo? Nome fora do padrão nunca entra em rotação. */
    public static function nomeValido(string $nome, string $prefixo): bool
    {
        return preg_match('/^'.preg_quote($prefixo, '/').'-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{4}[.]zip$/', $nome) === 1;
    }

    /** De que tipo é este arquivo? Null se não for um backup nosso. */
    public static function prefixoDe(string $nome): ?string
    {
        foreach ([self::PREFIXO_COMPLETO, self::PREFIXO_BANCO, self::PREFIXO_FOTOS] as $p) {
            if (self::nomeValido($nome, $p)) {
                return $p;
            }
        }

        return null;
    }

    public function pasta(): string
    {
        $p = storage_path('app/'.self::PASTA);
        if (! is_dir($p)) {
            @mkdir($p, 0755, true);
        }

        return $p;
    }

    /** Gera o zip e devolve ['arquivo' => caminho, 'fotos' => n, 'bytes' => tamanho]. */
    public function gerar(?string $destino = null): array
    {
        if (DB::connection()->getDriverName() !== 'sqlite') {
            throw new RuntimeException('Backup completo só para SQLite');
        }
        @ini_set('memory_limit', '512M');
        @set_time_limit(600);

        $destino = $destino ?: $this->pasta().'/petermann-'.now(PontoCalculo::TZ)->format('Y-m-d-Hi').'.zip';
        @unlink($destino);

        $tmpDb = storage_path('app/backup-'.now()->format('Ymd-His').'.sqlite');
        $this->copiarBanco($tmpDb);

        $zip = new ZipArchive;
        if ($zip->open($destino, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) {
            @unlink($tmpDb);
            throw new RuntimeException('Não consegui criar o zip do backup');
        }
        $zip->addFile($tmpDb, 'database.sqlite');

        $fotos = 0;
        foreach ($this->fotosDoDisco() as $rel => $caminho) {
            $this->guardarFoto($zip, $caminho, $rel);
            $fotos++;
        }
        $zip->addFromString('LEIA-ME.txt', $this->leiaMe($fotos));
        $zip->close();
        @unlink($tmpDb);

        return ['arquivo' => $destino, 'fotos' => $fotos, 'bytes' => filesize($destino) ?: 0];
    }

    /**
     * Zip só com o banco, para rodar todo dia (03/11/2026): uma pane perdia até
     * 7 dias de lançamentos. Devolve o mesmo formato de gerar(), com 'fotos' 0.
     * Falha lança exceção, e assim a rotação não roda: cópia ruim não empurra
     * as boas para fora.
     */
    public function gerarBanco(?string $destino = null): array
    {
        if (DB::connection()->getDriverName() !== 'sqlite') {
            throw new RuntimeException('Backup do banco só para SQLite');
        }
        @set_time_limit(600);

        $destino = $destino ?: $this->pasta().'/'.self::PREFIXO_BANCO.'-'.now(PontoCalculo::TZ)->format('Y-m-d-Hi').'.zip';
        @unlink($destino);

        $tmpDb = storage_path('app/backup-banco-'.now()->format('Ymd-His').'.sqlite');
        try {
            $this->copiarBanco($tmpDb);
            if (! is_file($tmpDb) || filesize($tmpDb) === 0) {
                throw new RuntimeException('A cópia do banco saiu vazia');
            }

            $zip = new ZipArchive;
            if ($zip->open($destino, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) {
                throw new RuntimeException('Não consegui criar o zip do backup do banco');
            }
            $zip->addFile($tmpDb, 'database.sqlite');
            $zip->addFromString('LEIA-ME.txt', $this->leiaMeBanco());
            if (! $zip->close()) {
                @unlink($destino);
                throw new RuntimeException('Não consegui fechar o zip do backup do banco');
            }
        } finally {
            @unlink($tmpDb);   // o zip só lê o arquivo no close()
        }

        return ['arquivo' => $destino, 'fotos' => 0, 'bytes' => filesize($destino) ?: 0];
    }

    /**
     * Zip com os anexos novos ou alterados desde o último completo (05/11/2026).
     * Devolve o formato de gerar() mais 'base', o completo usado; sem foto nova,
     * 'arquivo' vem null e nada é criado, para um zip vazio não empurrar os bons
     * para fora da rotação.
     *
     * A data sai do nome do completo: copiar ou restaurar o arquivo muda o filemtime
     * dele, e aí foto nova ficaria de fora sem ninguém ver. Sem completo não há o que
     * complementar, e mandar tudo aqui seria um completo disfarçado: lança exceção.
     *
     * Anexo que muda durante a montagem refaz o zip com a lista nova (ver gravarFotos):
     * sem isso saía foto cortada como sucesso. Se nunca estabilizar, é falha e não fica zip.
     */
    public function gerarFotos(?string $destino = null): array
    {
        @ini_set('memory_limit', '512M');
        @set_time_limit(600);

        $base = $this->listar()[0]['nome'] ?? null;
        if ($base === null) {
            throw new RuntimeException('Não há backup completo ('.self::PREFIXO_COMPLETO.'-*.zip) na pasta: sem ele as fotos novas não têm base. Rode backup:gerar primeiro.');
        }
        $corte = Carbon::createFromFormat('!Y-m-d-Hi', substr($base, strlen(self::PREFIXO_COMPLETO) + 1, 15), self::TZ)
            ->subDays(self::FOLGA_FOTOS_DIAS)->getTimestamp();

        $noCompleto = $this->entradasDoCompleto($base);
        $destino = $destino ?: $this->pasta().'/'.self::PREFIXO_FOTOS.'-'.now(PontoCalculo::TZ)->format('Y-m-d-Hi').'.zip';

        for ($tentativa = 1; $tentativa <= self::TENTATIVAS_FOTOS; $tentativa++) {
            $novas = $this->fotosNovas($corte, $noCompleto);
            if ($novas === []) {
                return ['arquivo' => null, 'fotos' => 0, 'bytes' => 0, 'base' => $base];
            }
            if ($this->gravarFotos($destino, $novas, $base)) {
                return ['arquivo' => $destino, 'fotos' => count($novas), 'bytes' => filesize($destino) ?: 0, 'base' => $base];
            }
            @unlink($destino);
        }

        /* lança para a rotação não rodar: zip ruim não empurra os bons para fora */
        throw new RuntimeException('Não consegui fechar o zip das fotos novas depois de '.self::TENTATIVAS_FOTOS.' tentativas');
    }

    /**
     * O que falta no completo: mudou depois do corte OU está diferente do que ele guardou
     * (05/11/2026). Só a data não basta: anexo em espera promovido depois do completo traz
     * a data do upload, ficava antes do corte, e a restauração devolvia o comprovante velho
     * sem erro nenhum. O filectime não serve: no Windows é a data de criação, e a regra só
     * valeria no servidor, sem teste que a prove. Com $noCompleto null, fica só a data.
     */
    private function fotosNovas(int $corte, ?array $noCompleto): array
    {
        $novas = [];
        foreach ($this->fotosDoDisco() as $rel => $caminho) {
            /* .tmp- é gravação em andamento: não é anexo, e sumir antes do close() derrubaria o zip inteiro */
            if (str_starts_with(basename($rel), self::TMP_PREFIXO)) {
                continue;
            }
            $quando = @filemtime($caminho);
            if ($quando === false) {
                continue;
            }
            $guardado = $noCompleto[$rel] ?? null;
            $diferente = $noCompleto !== null && ($guardado === null
                || $guardado['size'] !== @filesize($caminho)
                || abs($guardado['mtime'] - $quando) > self::FOLGA_DATA_ZIP_SEG);
            if ($quando >= $corte || $diferente) {
                $novas[$rel] = $caminho;
            }
        }

        return $novas;
    }

    /**
     * Índice do completo, caminho dentro de fotos/ => size e mtime. Lê só o diretório
     * central do zip, então não pesa mesmo com vários GB. Completo que não abre não para
     * o backup do dia, que ainda protege o que é novo: fica a data e o motivo vai para o log.
     */
    private function entradasDoCompleto(string $nome): ?array
    {
        $zip = new ZipArchive;
        if ($zip->open($this->pasta().'/'.$nome) !== true) {
            Log::warning("backup de fotos: não consegui ler {$nome}, comparando só pela data");

            return null;
        }
        $out = [];
        for ($i = 0; $i < $zip->numFiles; $i++) {
            $st = $zip->statIndex($i);
            if ($st !== false && str_starts_with($st['name'], 'fotos/')) {
                $out[substr($st['name'], strlen('fotos/'))] = ['size' => $st['size'], 'mtime' => $st['mtime']];
            }
        }
        $zip->close();

        return $out;
    }

    /**
     * Grava o zip e diz se ele saiu fiel ao disco (05/11/2026). O tamanho é fixado no
     * addFile e o arquivo só é lido no close(): trocado no meio por um maior (salvarPara
     * move por cima), o close() devolve true e a foto sai cortada; por um menor ou apagado,
     * o close() falha. Medido com libzip 1.12. False pede outra tentativa com a lista nova.
     */
    private function gravarFotos(string $destino, array $novas, string $base): bool
    {
        @unlink($destino);

        $zip = new ZipArchive;
        if ($zip->open($destino, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) {
            throw new RuntimeException('Não consegui criar o zip das fotos novas');
        }
        foreach ($novas as $rel => $caminho) {
            $this->guardarFoto($zip, $caminho, (string) $rel);
        }
        $zip->addFromString('LEIA-ME.txt', $this->leiaMeFotos(count($novas), $base));

        return $this->fecharZip($zip) && $this->tamanhosConferem($destino, $novas);
    }

    /** Separado para o teste poder mexer no anexo no único intervalo em que a corrida existe. */
    protected function fecharZip(ZipArchive $zip): bool
    {
        return @$zip->close();
    }

    private function tamanhosConferem(string $destino, array $novas): bool
    {
        $zip = new ZipArchive;
        if ($zip->open($destino) !== true) {
            return false;
        }
        clearstatcache();
        $ok = true;
        foreach ($novas as $rel => $caminho) {
            $st = $zip->statName('fotos/'.$rel);
            if ($st === false || $st['size'] !== @filesize($caminho)) {
                $ok = false;
                break;
            }
        }
        $zip->close();

        return $ok;
    }

    /**
     * Anexos do disco, sem as miniaturas: caminho dentro de fotos/ => caminho real.
     * Generator porque o completo passa por tudo, e a lista não precisa ficar em memória.
     */
    private function fotosDoDisco(): \Generator
    {
        $raiz = rtrim(app(FotoStorage::class)->disk()->path(''), '/\\');
        if (! is_dir($raiz)) {
            return;
        }
        $it = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($raiz, \FilesystemIterator::SKIP_DOTS));
        foreach ($it as $f) {
            /** @var \SplFileInfo $f */
            $rel = str_replace('\\', '/', substr($f->getPathname(), strlen($raiz) + 1));
            if (str_contains($rel, '/'.FotoStorage::MINI_DIR.'/')) {
                continue;
            }
            yield $rel => $f->getPathname();
        }
    }

    /** addFile só anota o caminho e o close() copia em fluxo: zip grande não passa pela memória do PHP. */
    private function guardarFoto(ZipArchive $zip, string $caminho, string $rel): void
    {
        $zip->addFile($caminho, 'fotos/'.$rel);
        $zip->setCompressionName('fotos/'.$rel, ZipArchive::CM_STORE);
    }

    /**
     * Cópia íntegra do banco mesmo com gente gravando. VACUUM INTO só existe
     * do SQLite 3.27 em diante e a Locaweb roda 3.26 — lá usa a API de
     * backup do próprio SQLite (SQLite3::backup), que também é consistente.
     */
    public function copiarBanco(string $destino): void
    {
        @unlink($destino);
        $origem = (string) DB::connection()->getDatabaseName();
        try {
            DB::statement('VACUUM INTO '.DB::connection()->getPdo()->quote($destino));
            if (is_file($destino) && filesize($destino) > 0) {
                return;
            }
        } catch (\Throwable) {
            // versão antiga: cai no backup API
        }
        if (! class_exists(\SQLite3::class)) {
            throw new RuntimeException('Sem VACUUM INTO nem extensão sqlite3 para copiar o banco');
        }
        $src = new \SQLite3($origem, SQLITE3_OPEN_READONLY);
        $dst = new \SQLite3($destino);
        $ok = $src->backup($dst);
        $dst->close();
        $src->close();
        if (! $ok || ! is_file($destino)) {
            throw new RuntimeException('SQLite3::backup falhou');
        }
    }

    /** Lista os backups guardados de um tipo (padrão: os completos), mais novo primeiro. */
    public function listar(string $prefixo = self::PREFIXO_COMPLETO): array
    {
        $out = [];
        foreach (glob($this->pasta().'/'.$prefixo.'-*.zip') ?: [] as $f) {
            if (! self::nomeValido(basename($f), $prefixo)) {
                continue;
            }
            $out[] = ['nome' => basename($f), 'bytes' => filesize($f) ?: 0, 'em' => date('c', filemtime($f) ?: time())];
        }
        usort($out, fn ($a, $b) => strcmp($b['nome'], $a['nome']));

        return $out;
    }

    /**
     * Rotação (21/09/2026, disco ilimitado): guarda as $manter cópias mais
     * novas E a primeira cópia de cada mês nos últimos $meses meses. Assim
     * "a nota que alguém apagou em março" continua recuperável. Devolve
     * quantos apagou. Só mexe no tipo de $prefixo (03/11/2026).
     */
    public function podar(int $manter, int $meses = 12, string $prefixo = self::PREFIXO_COMPLETO): int
    {
        $n = 0;
        foreach (self::paraApagar($this->listar($prefixo), $manter, $meses, $prefixo) as $b) {
            if (@unlink($this->pasta().'/'.$b['nome'])) {
                $n++;
            }
        }

        return $n;
    }

    /**
     * Decide quem sai, dada a lista (mais novo primeiro, cada item com
     * 'nome' petermann-AAAA-MM-DD-HHMM…). Puro: o DriveBackup usa a mesma
     * regra para a pasta no Drive.
     *
     * Só decide sobre nomes do tipo $prefixo; o resto da lista é ignorado, não
     * apagado. A trava mora aqui (03/11/2026) para valer em todo chamador: uma
     * rodada diária jamais apaga um ZIP completo, nem o contrário.
     */
    public static function paraApagar(array $lista, int $manter, int $meses = 12, string $prefixo = self::PREFIXO_COMPLETO): array
    {
        $lista = array_values(array_filter($lista, fn ($b) => self::nomeValido($b['nome'], $prefixo)));
        usort($lista, fn ($a, $b) => strcmp($b['nome'], $a['nome']));
        $recentes = array_slice($lista, 0, max(0, $manter));
        $fica = array_column($recentes, 'nome', 'nome');

        /* $meses = 0 → sem cópia mensal: fica exatamente o número pedido em
           $manter (22/09/2026, pedido do Cleiton para ocupar menos espaço). */
        if ($meses > 0) {
            $limiteMes = now(self::TZ)->startOfMonth()->subMonths($meses)->format('Y-m');
            $porMes = [];
            foreach (array_reverse($lista) as $b) {   // do mais antigo para o mais novo: o 1º de cada mês ganha
                if (! preg_match('/-(\d{4}-\d{2})-\d{2}-\d{4}/', $b['nome'], $m)) {
                    continue;
                }
                if ($m[1] >= $limiteMes && ! isset($porMes[$m[1]])) {
                    $porMes[$m[1]] = $b['nome'];
                }
            }
            $fica += array_combine($porMes, $porMes);
        }

        return array_values(array_filter($lista, fn ($b) => ! isset($fica[$b['nome']])));
    }

    /** Só os completos: é o que a tela do app lista e baixa. O banco-*.zip não sai por aqui. */
    public function caminhoDe(string $nome): ?string
    {
        if (! self::nomeValido($nome, self::PREFIXO_COMPLETO)) {
            return null;
        }
        $p = $this->pasta().'/'.$nome;

        return is_file($p) ? $p : null;
    }

    private function leiaMe(int $fotos): string
    {
        return "Backup do Petermann App — ".now(PontoCalculo::TZ)->format('d/m/Y H:i')."\n\n"
            ."database.sqlite : o banco inteiro (notas, repasses, colaboradores, frota, ponto)\n"
            ."fotos/          : {$fotos} anexos, na mesma estrutura do servidor (<colaborador>/<nota>.ext)\n\n"
            ."Para restaurar: copiar database.sqlite para api-petermann/database/ e a pasta fotos/\n"
            ."para api-petermann/storage/app/fotos/ (as miniaturas são refeitas sozinhas).\n";
    }

    private function leiaMeBanco(): string
    {
        return "Backup diário do banco do Petermann App — ".now(PontoCalculo::TZ)->format('d/m/Y H:i')."\n\n"
            ."database.sqlite : o banco inteiro (notas, repasses, colaboradores, frota, ponto)\n"
            ."As fotos NÃO estão aqui: elas vêm no zip completo (petermann-*.zip) de domingo.\n\n"
            ."Para restaurar: copiar database.sqlite para api-petermann/database/.\n";
    }

    private function leiaMeFotos(int $fotos, string $base): string
    {
        return "Backup diário das fotos do Petermann App — ".now(PontoCalculo::TZ)->format('d/m/Y H:i')."\n\n"
            ."fotos/ : {$fotos} anexos novos ou alterados desde o completo {$base}\n"
            ."O banco e as fotos mais antigas NÃO estão aqui, e as miniaturas são refeitas sozinhas.\n\n"
            ."Para restaurar, nesta ordem:\n"
            ."1. Copiar o conteúdo de fotos/ do completo {$base} para api-petermann/storage/app/fotos/.\n"
            ."2. Copiar por cima o conteúdo de fotos/ deste zip. Use só o fotos-*.zip mais novo: ele já\n"
            ."   traz o que os dos dias anteriores trouxeram. Se existir um completo mais novo que este\n"
            ."   zip, use o completo e ignore este.\n"
            ."3. Copiar database.sqlite do banco-*.zip mais novo para api-petermann/database/.\n";
    }
}
