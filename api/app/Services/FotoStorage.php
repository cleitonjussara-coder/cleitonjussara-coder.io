<?php

namespace App\Services;

use App\Models\Nota;
use Illuminate\Contracts\Filesystem\Filesystem;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use InvalidArgumentException;
use League\Flysystem\CorruptedPathDetected;
use League\Flysystem\PathTraversalDetected;

/**
 * Anexos das notas no DISCO do servidor. O MySQL guarda apenas o caminho
 * relativo (notas.foto_path); o binário nunca entra no banco.
 *
 * Caminho determinístico, igual ao que o Storage do Supabase usava:
 *   <user_id>/<nota_id>.<ext>
 * É o que permite reconectar uma nota ao arquivo dela só pelo id
 * (repararOrfas) e organizar a pasta por colaborador.
 */
class FotoStorage
{
    public const EXTS = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'gif', 'pdf', 'xml'];

    public const MIME = [
        'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'png' => 'image/png',
        'webp' => 'image/webp', 'heic' => 'image/heic', 'gif' => 'image/gif',
        'pdf' => 'application/pdf', 'xml' => 'application/xml',
    ];

    public function disk(): Filesystem
    {
        return Storage::disk('fotos');
    }

    /** Extensão normalizada a partir do nome/MIME do arquivo enviado. */
    public function extensaoDe(UploadedFile $file, ?string $hint = null): string
    {
        $ext = strtolower($hint ?: ($file->getClientOriginalExtension() ?: ''));
        if ($ext === 'jpeg') {
            $ext = 'jpg';
        }
        if (! in_array($ext, self::EXTS, true)) {
            $mime = strtolower($file->getMimeType() ?: '');
            $ext = match (true) {
                $mime === 'application/pdf' => 'pdf',
                in_array($mime, ['text/xml', 'application/xml'], true) => 'xml',
                $mime === 'image/png' => 'png',
                $mime === 'image/webp' => 'webp',
                in_array($mime, ['image/heic', 'image/heif'], true) => 'heic',
                $mime === 'image/gif' => 'gif',
                default => 'jpg',
            };
        }

        return $ext;
    }

    public function caminho(Nota $nota, string $ext): string
    {
        return "{$this->pastaDe($nota)}/{$nota->id}.{$ext}";
    }

    /** Grava o arquivo e devolve o caminho relativo a guardar em foto_path. */
    public function salvar(Nota $nota, UploadedFile $file, ?string $extHint = null): string
    {
        return $this->salvarPara($this->pastaDe($nota), $nota->id, $file, $extHint);
    }

    /** Nota de Faturamento sem colaborador (28/09/2026) não tem user_id — a
     *  pasta do anexo cai numa pasta fixa, nunca um id de colaborador de verdade. */
    public function pastaDe(Nota $nota): string
    {
        return $nota->user_id ?? Nota::PASTA_GERAL;
    }

    /** Idem, sem precisar da linha da nota (o anexo sobe antes dela existir). */
    public function salvarPara(string $userId, string $notaId, UploadedFile $file, ?string $extHint = null): string
    {
        $ext = $this->extensaoDe($file, $extHint);
        $final = "{$userId}/{$notaId}.{$ext}";

        /* 04/11/2026: o novo é gravado ANTES de o antigo sair. Apagar primeiro perdia o comprovante se a gravação falhasse.
           O nome temporário é único por envio (o app pode reenviar enquanto o primeiro corre) e nunca vale como anexo:
           arquivoDaNota compara o nome exato e validarCaminho recusa o ponto inicial. A falha sobe (disco com throw) e o
           app tenta de novo. */
        $temp = "{$userId}/".self::TMP_PREFIXO."{$notaId}-".Str::random(8).".{$ext}";
        try {
            $this->disk()->putFileAs($userId, $file, basename($temp));
            /* 23/09/2026: rede de segurança. O app novo já manda a foto em pé,
               mas versão antiga (e qualquer outro cliente) manda o JPEG cru, com
               a rotação só no EXIF — e aí PDF, ZIP e planilha saem deitados. */
            $this->endireitar($temp);
            $this->disk()->move($temp, $final);   // mesma extensão: troca o antigo de uma vez
        } finally {
            $this->apagar($temp);
        }
        /* Troca de formato (jpg → pdf) não pode deixar o arquivo antigo para
           trás: o caminho muda e o velho viraria órfão para sempre. */
        $this->apagarVersoesDe($userId, $notaId, $final);

        return $final;
    }

    /**
     * Regrava o JPEG já rotacionado, sem o EXIF de orientação. Devolve true
     * se mexeu no arquivo. Serve na gravação e no mutirão das fotos antigas
     * (artisan fotos:endireitar).
     */
    public function endireitar(string $path): bool
    {
        $ext = strtolower(pathinfo($path, PATHINFO_EXTENSION));
        if (! in_array($ext, ['jpg', 'jpeg'], true) || ! $this->existe($path)) {
            return false;
        }
        if (! function_exists('imagecreatefromstring') || ! function_exists('exif_read_data')) {
            return false;
        }
        try {
            $bin = $this->disk()->get($path);
            $exif = @exif_read_data('data://image/jpeg;base64,'.base64_encode($bin));
            $o = (int) ($exif['Orientation'] ?? 1);
            if ($o <= 1) {
                return false;                 // já está em pé
            }
            $img = @imagecreatefromstring($bin);
            if (! $img) {
                return false;
            }
            $img = $this->corrigirOrientacao($img, $bin, $ext);
            ob_start();
            imagejpeg($img, null, 88);
            $jpg = ob_get_clean();
            imagedestroy($img);
            if (! $jpg) {
                return false;
            }
            $this->disk()->put($path, $jpg);
            $this->apagar($this->caminhoMini($path));   // miniatura velha some; nasce da foto certa

            return true;
        } catch (\Throwable) {
            return false;
        }
    }

    /* 03/11/2026: caminho malicioso já gravado no banco ("../../.env") fazia o Flysystem lançar exceção e derrubava Arquivos
       e ZIP com 500. Só caminho inválido vira "não existe"; falha de verdade do disco continua aparecendo. */
    public function existe(?string $path): bool
    {
        try {
            return $path !== null && $path !== '' && $this->disk()->exists($path);
        } catch (PathTraversalDetected|CorruptedPathDetected) {
            return false;
        }
    }

    public function apagar(?string $path): void
    {
        if ($this->existe($path)) {
            $this->disk()->delete($path);
        }
    }

    /** Remove qualquer <nota_id>.* da pasta do dono. */
    public function apagarTodasVersoes(Nota $nota): void
    {
        $this->apagarVersoesDe($this->pastaDe($nota), $nota->id);
        $this->descartarEspera($this->pastaDe($nota), $nota->id);
        $this->disk()->delete($this->esperasHerdadas($this->pastaDe($nota), $nota->id));
        $this->apagar($this->original($this->pastaDe($nota), $nota->id));
        /* 04/11/2026: nota que trocou de dono antes de o anexo passar a mudar junto ainda aponta para a pasta antiga */
        $declarado = $this->anexoDeclarado($nota->foto_path, $nota->id);
        if ($declarado !== null) {
            $this->apagarVersoesDe(dirname($declarado), $nota->id);
        }
    }

    /* ── Troca de dono (04/11/2026) ─────────────────────────────────
       O acesso ao anexo vale pela pasta (FotoController::podeVer), então a nota que muda de dono tem de levar o arquivo. Em
       duas fases, porque nenhum comprovante pode sumir: levarParaPasta só COPIA; a origem sai em concluirMudanca, depois de
       a nota gravada. Se a cópia falhar a exceção sobe sem sobrar nada; se a gravação falhar, desfazerMudanca tira as cópias. */

    /** @return array{foto_path: ?string, origens: list<string>, copias: list<string>} */
    public function levarParaPasta(string $notaId, ?string $fotoPath, string $de, string $para): array
    {
        $m = ['foto_path' => $fotoPath, 'origens' => [], 'copias' => []];
        try {
            /* o caminho vem do banco, e só vale se for desta nota: linha antiga pode apontar para o arquivo de outra */
            $origem = $this->anexoDeclarado($fotoPath, $notaId) ?? $this->arquivoDaNota($de, $notaId);
            if ($origem === null) {
                if ($fotoPath) {
                    \Illuminate\Support\Facades\Log::warning('troca de dono: anexo da nota não encontrado no disco', ['nota' => $notaId, 'foto_path' => $fotoPath]);
                }
            } elseif (dirname($origem) === $para) {
                $m['foto_path'] = $origem;   // nota legada voltando ao dono da pasta: o arquivo já está no lugar
            } else {
                $destino = "{$para}/".basename($origem);
                $this->copiarConferindo($origem, $destino, $m);
                $this->apagarVersoesDe($para, $notaId, $destino);   // sobra de outro formato viraria órfã
                $m['foto_path'] = $destino;
                $this->levarMiniatura($origem, $destino, $m);
            }

            if ($de !== $para) {
                $this->guardarEsperasDoDonoAnterior($notaId, $de, $para, $m);
                /* a foto original vai junto (13/11/2026); a origem sai em concluirMudanca, como o anexo */
                $orig = $this->original($de, $notaId);
                if ($orig !== null) {
                    $this->apagar($this->original($para, $notaId));
                    $this->copiarConferindo($orig, "{$para}/".self::ORIGINAL_DIR.'/'.basename($orig), $m);
                }
            }
        } catch (\Throwable $e) {
            $this->desfazerMudanca($m);
            throw $e;
        }

        return $m;
    }

    /* 04/11/2026: a espera aguardava um PUT do dono antigo, que agora toma 403 e nunca a resolve. Na espera do novo dono, o
       primeiro PUT dele a promoveria e apagaria o comprovante, sem ninguém pedir. Mas o aparelho de quem enviou já soltou a
       cópia dele, então também não se apaga: fica guardada em ESPERA_HERDADA_DIR, sem virar anexo, até a nota ser apagada.
       O nome leva sufixo porque duas esperas do mesmo formato podem se encontrar em trocas seguidas. */
    private function guardarEsperasDoDonoAnterior(string $notaId, string $de, string $para, array &$m): void
    {
        $esperas = $this->esperasHerdadas($de, $notaId);
        $pendente = $this->arquivoDaNota("{$de}/".self::ESPERA_DIR, $notaId);
        if ($pendente !== null) {
            $esperas[] = $pendente;
        }
        foreach ($esperas as $e) {
            $this->copiarConferindo($e, "{$para}/".self::ESPERA_HERDADA_DIR."/{$notaId}.".Str::random(8).'.'.pathinfo($e, PATHINFO_EXTENSION), $m);
        }
        if ($esperas !== []) {
            \Illuminate\Support\Facades\Log::warning('troca de dono: anexo em espera guardado sem virar anexo da nota', ['nota' => $notaId, 'de' => $de, 'para' => $para, 'arquivos' => $esperas]);
        }
    }

    /** @return list<string> */
    private function esperasHerdadas(string $pasta, string $notaId): array
    {
        return array_values(array_filter(
            $this->disk()->files("{$pasta}/".self::ESPERA_HERDADA_DIR),
            fn ($f) => str_starts_with(basename($f), "{$notaId}."),
        ));
    }

    /** A nota já aponta para o destino: sobra na origem é só lixo, então falha aqui avisa e não derruba o envio. */
    public function concluirMudanca(array $m): void
    {
        $this->apagarSemDerrubar($m['origens'], 'origem');
    }

    public function desfazerMudanca(array $m): void
    {
        $this->apagarSemDerrubar($m['copias'], 'cópia');
    }

    private function apagarSemDerrubar(array $caminhos, string $oQue): void
    {
        foreach ($caminhos as $c) {
            try {
                $this->apagar($c);
            } catch (\Throwable $e) {
                \Illuminate\Support\Facades\Log::warning("troca de dono: {$oQue} não apagada", ['caminho' => $c, 'erro' => $e->getMessage()]);
            }
        }
    }

    /* Copia para um temporário e só dá o nome final depois de conferir o tamanho: disco cheio não deixa arquivo pela metade. */
    private function copiarConferindo(string $origem, string $destino, array &$m): void
    {
        $temp = dirname($destino).'/'.self::TMP_PREFIXO.pathinfo($destino, PATHINFO_FILENAME).'-'.Str::random(8).'.'.pathinfo($destino, PATHINFO_EXTENSION);
        try {
            $this->disk()->copy($origem, $temp);
            if ($this->disk()->size($temp) !== $this->disk()->size($origem)) {
                throw new \RuntimeException("cópia incompleta de {$origem}");
            }
            $this->disk()->move($temp, $destino);
        } finally {
            $this->apagar($temp);
        }
        $m['copias'][] = $destino;
        $m['origens'][] = $origem;
    }

    /* Miniatura se refaz sozinha na primeira vez que alguém pede: falhar aqui não pode segurar a troca de dono. */
    private function levarMiniatura(string $origem, string $destino, array &$m): void
    {
        $mini = $this->caminhoMini($origem);
        try {
            if ($this->existe($mini)) {
                $this->copiarConferindo($mini, $this->caminhoMini($destino), $m);
            }
        } catch (\Throwable) {
            $m['origens'][] = $mini;
        }
    }

    /* foto_path só conta como anexo da nota se for <pasta>/<nota_id>.<ext> e o arquivo existir. */
    private function anexoDeclarado(?string $path, string $notaId): ?string
    {
        try {
            $p = $this->validarCaminho((string) $path);
        } catch (InvalidArgumentException) {
            return null;
        }

        return substr_count($p, '/') === 1 && pathinfo($p, PATHINFO_FILENAME) === $notaId && $this->existe($p) ? $p : null;
    }

    /* 04/11/2026: temporário de quem morreu no meio da gravação. Com $manter (troca de anexo) só sai o velho, porque o recente
       pode ser de outro envio em andamento; sem ele (anexo apagado) sai tudo. */
    private const TMP_PREFIXO = '.tmp-';

    private const TMP_VIDA_SEG = 3600;

    /** $manter: a versão recém-gravada, que fica. A miniatura sai sempre: era da versão antiga. */
    public function apagarVersoesDe(string $userId, string $notaId, ?string $manter = null): void
    {
        foreach ($this->disk()->files($userId) as $f) {
            if ($f === $manter) {
                continue;
            }
            $temporario = str_starts_with(basename($f), self::TMP_PREFIXO."{$notaId}-");
            if (pathinfo($f, PATHINFO_FILENAME) === $notaId
                || ($temporario && ($manter === null || $this->disk()->lastModified($f) < time() - self::TMP_VIDA_SEG))) {
                $this->disk()->delete($f);
            }
        }
        $this->apagar("{$userId}/".self::MINI_DIR."/{$notaId}.jpg");
    }

    /* ── Anexo em espera (03/11/2026) ───────────────────────────────
       O app sobe o anexo ANTES do PUT, e só o PUT diz de qual versão a edição veio. Em nota que a gestão corrigiu por
       último, o arquivo fica em <pasta>/espera/ sem encostar no atual: o PUT aceito o promove, o 409 o descarta. Fora de
       arquivoDaNota() e de validarCaminho() de propósito: não vira anexo de nota nem sai por URL. */
    public const ESPERA_DIR = 'espera';

    /** Espera do dono anterior (ver guardarEsperasDoDonoAnterior). Nada a promove, e também fica fora de validarCaminho(). */
    public const ESPERA_HERDADA_DIR = 'espera-herdada';

    /* ── Foto original (13/11/2026) ─────────────────────────────────
       Gestor, admin e o dono podem ajustar a foto de uma nota já enviada (girar, recortar, melhorar). A PRIMEIRA troca guarda o
       anexo de antes em <pasta>/original/<nota_id>.<ext>, e as seguintes não mexem nele: é sempre o que chegou primeiro. Dá para
       voltar a ele (restaurarOriginal), e ele acompanha a nota na troca de dono e sai junto quando a nota é apagada. Fora de
       validarCaminho() e de arquivoDaNota(): não vira anexo por engano nem sai por URL. */
    public const ORIGINAL_DIR = 'original';

    /** Guarda o anexo atual como original se ainda não há um. $atual é o foto_path da nota antes da troca. */
    public function guardarOriginal(string $pasta, string $notaId, ?string $atual): void
    {
        $origem = $this->anexoDeclarado($atual, $notaId) ?? $this->arquivoDaNota($pasta, $notaId);
        if ($origem === null || $this->original($pasta, $notaId) !== null) {
            return;
        }
        $m = ['copias' => [], 'origens' => []];
        $this->copiarConferindo($origem, "{$pasta}/".self::ORIGINAL_DIR.'/'.basename($origem), $m);
    }

    public function original(string $pasta, string $notaId): ?string
    {
        return $this->arquivoDaNota("{$pasta}/".self::ORIGINAL_DIR, $notaId);
    }

    /** A foto original volta a ser o anexo (e continua guardada). Devolve o caminho do anexo, ou null se não há original. */
    public function restaurarOriginal(string $pasta, string $notaId): ?string
    {
        $orig = $this->original($pasta, $notaId);
        if ($orig === null) {
            return null;
        }
        $final = "{$pasta}/".basename($orig);
        $m = ['copias' => [], 'origens' => []];
        $this->copiarConferindo($orig, $final, $m);   // por temporário: o anexo atual só sai com o original no lugar
        $this->apagarVersoesDe($pasta, $notaId, $final);
        try {
            $this->miniatura($final);
        } catch (\Throwable) {
        }

        return $final;
    }

    /** Devolve o caminho que o anexo terá quando for promovido. */
    public function guardarEmEspera(string $pasta, string $notaId, UploadedFile $file, ?string $extHint = null): string
    {
        $ext = $this->extensaoDe($file, $extHint);
        $this->descartarEspera($pasta, $notaId);
        $this->disk()->putFileAs("{$pasta}/".self::ESPERA_DIR, $file, "{$notaId}.{$ext}");

        return "{$pasta}/{$notaId}.{$ext}";
    }

    /** Devolve true se havia anexo em espera. */
    public function descartarEspera(string $pasta, string $notaId): bool
    {
        $arquivo = $this->arquivoDaNota("{$pasta}/".self::ESPERA_DIR, $notaId);
        if ($arquivo !== null) {
            $this->disk()->delete($arquivo);
        }

        return $arquivo !== null;
    }

    /** 06/11/2026: quem promove precisa ler o anexo atual antes, e só vale a pena quando há mesmo algo esperando. */
    public function temEspera(string $pasta, string $notaId): bool
    {
        return $this->arquivoDaNota("{$pasta}/".self::ESPERA_DIR, $notaId) !== null;
    }

    /** 06/11/2026: sha1 do anexo em espera, ou null se não há nenhum. O mês fechado compara com o atual antes de dizer "nada mudou". */
    public function conteudoDaEspera(string $pasta, string $notaId): ?string
    {
        $arquivo = $this->arquivoDaNota("{$pasta}/".self::ESPERA_DIR, $notaId);

        return $arquivo === null ? null : sha1((string) $this->disk()->get($arquivo));
    }

    /** O anexo em espera vira o anexo da nota. Devolve o caminho novo, ou null se não havia nada esperando. */
    public function promoverEspera(string $pasta, string $notaId): ?string
    {
        $arquivo = $this->arquivoDaNota("{$pasta}/".self::ESPERA_DIR, $notaId);
        if ($arquivo === null) {
            return null;
        }
        $final = "{$pasta}/".basename($arquivo);
        /* 04/11/2026: mesma regra de salvarPara, o antigo só sai com o novo no lugar. Se o move falhar, o erro sobe antes de a
           nota ser gravada e os dois arquivos ficam onde estavam. */
        $this->disk()->move($arquivo, $final);
        $this->apagarVersoesDe($pasta, $notaId, $final);
        $this->endireitar($final);
        try {
            $this->miniatura($final);
        } catch (\Throwable) {
        }

        return $final;
    }

    /* ── Miniaturas (19/09/2026) ────────────────────────────────────
       A tela Arquivos lista dezenas de notas de uma vez; servir a foto
       inteira (~1 MB) em cada quadradinho travaria no 4G. A miniatura
       (lado maior 360 px, ~20 KB) fica em <user_id>/mini/<nota_id>.jpg,
       gerada no upload e, se faltar, na primeira vez que alguém pede.
       Só imagens que o GD decodifica (jpg/png/gif/webp); PDF/HEIC → null. */
    public const MINI_DIR = 'mini';

    public const MINI_LADO = 360;

    public function caminhoMini(string $path): string
    {
        [$user, $arq] = explode('/', $path, 2);

        return "{$user}/".self::MINI_DIR.'/'.pathinfo($arq, PATHINFO_FILENAME).'.jpg';
    }

    /** Caminho da miniatura pronta (gera se faltar) ou null se não dá para gerar. */
    public function miniatura(string $path): ?string
    {
        $mini = $this->caminhoMini($path);
        if ($this->disk()->exists($mini)) {
            return $mini;
        }
        if (! function_exists('imagecreatefromstring') || ! $this->existe($path)) {
            return null;
        }
        $ext = strtolower(pathinfo($path, PATHINFO_EXTENSION));
        if (! in_array($ext, ['jpg', 'jpeg', 'png', 'gif', 'webp'], true)) {
            return null;
        }
        try {
            $bin = $this->disk()->get($path);
            $img = @imagecreatefromstring($bin);
            if (! $img) {
                return null;
            }
            $img = $this->corrigirOrientacao($img, $bin, $ext);
            $w = imagesx($img);
            $h = imagesy($img);
            $escala = min(1, self::MINI_LADO / max($w, $h, 1));
            $nw = max(1, (int) round($w * $escala));
            $nh = max(1, (int) round($h * $escala));
            $out = imagecreatetruecolor($nw, $nh);
            $branco = imagecolorallocate($out, 255, 255, 255);   // png transparente → fundo branco
            imagefill($out, 0, 0, $branco);
            imagecopyresampled($out, $img, 0, 0, 0, 0, $nw, $nh, $w, $h);
            ob_start();
            imagejpeg($out, null, 72);
            $jpg = ob_get_clean();
            imagedestroy($out);
            imagedestroy($img);
            if ($jpg === '' || $jpg === false) {
                return null;
            }
            $this->disk()->put($mini, $jpg);

            return $mini;
        } catch (\Throwable) {
            return null;
        }
    }

    /** Foto de celular vem "deitada" com a orientação só no EXIF; sem isto a miniatura sai girada. */
    private function corrigirOrientacao(\GdImage $img, string $bin, string $ext): \GdImage
    {
        if (! in_array($ext, ['jpg', 'jpeg'], true) || ! function_exists('exif_read_data')) {
            return $img;
        }
        try {
            $exif = @exif_read_data('data://image/jpeg;base64,'.base64_encode($bin));
            $o = (int) ($exif['Orientation'] ?? 1);
        } catch (\Throwable) {
            return $img;
        }
        $rot = match ($o) { 3 => 180, 6 => -90, 8 => 90, default => 0 };
        if ($rot === 0) {
            return $img;
        }
        $r = imagerotate($img, $rot, 0);
        if ($r) {
            imagedestroy($img);

            return $r;
        }

        return $img;
    }

    /**
     * Nome do arquivo da nota na pasta do dono, se existir (sem depender de
     * foto_path). Usado para reconectar notas que perderam a referência.
     */
    public function arquivoDaNota(string $userId, string $notaId): ?string
    {
        foreach ($this->disk()->files($userId) as $f) {
            if (pathinfo($f, PATHINFO_FILENAME) === $notaId) {
                return $f;
            }
        }

        return null;
    }

    public function mimeDe(string $path): string
    {
        $ext = strtolower(pathinfo($path, PATHINFO_EXTENSION));

        return self::MIME[$ext] ?? 'application/octet-stream';
    }

    /** Rejeita qualquer tentativa de sair da pasta de fotos ("../", absoluto). */
    public function validarCaminho(string $path): string
    {
        $path = str_replace('\\', '/', trim($path));
        if ($path === '' || str_contains($path, '..') || str_starts_with($path, '/')
            || ! preg_match('#^[A-Za-z0-9\-]+/(mini/)?[A-Za-z0-9\-]+\.[a-z0-9]+$#', $path)) {
            throw new InvalidArgumentException('Caminho de anexo inválido');
        }

        return $path;
    }
}
