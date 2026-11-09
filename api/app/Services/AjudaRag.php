<?php

namespace App\Services;

use App\Models\Colaborador;
use DOMDocument;
use DOMElement;
use DOMXPath;
use Illuminate\Support\Facades\Cache;

/**
 * RAG do assistente do "Como usar" (01/11/2026): busca por palavras (BM25) sobre os parágrafos da própria ajuda
 * do app, sem embeddings e sem tabela nova — a Locaweb está sem shell e a Anthropic não oferece embeddings.
 *
 * A fonte é api/resources/ajuda/ajuda-conteudo.html, cópia de svelte-ajuda/src/ajuda-conteudo.html (um teste
 * acusa se as duas divergirem). Cada parágrafo guarda a quem se destina, com as MESMAS regras de visibilidade do
 * CSS de svelte-ajuda/src/App.svelte: o assistente nunca cita ao colaborador o que a tela de ajuda esconderia.
 */
class AjudaRag
{
    private const ARQUIVO = 'resources/ajuda/ajuda-conteudo.html';

    private const MAX_CHUNK = 900;

    private const STOP = [
        'a', 'o', 'as', 'os', 'um', 'uma', 'de', 'do', 'da', 'dos', 'das', 'em', 'no', 'na', 'nos', 'nas', 'por', 'para',
        'pra', 'com', 'sem', 'e', 'ou', 'que', 'se', 'ao', 'aos', 'como', 'qual', 'quais', 'onde', 'quando', 'eu', 'meu',
        'minha', 'meus', 'minhas', 'me', 'ser', 'esta', 'este', 'isso', 'isto', 'ele', 'ela', 'fazer', 'faco', 'posso',
        'pode', 'tem', 'ter', 'ja', 'mais', 'muito', 'so', 'sao', 'foi', 'vai', 'esta', 'estou', 'ha',
    ];

    /** @return array<int, array{titulo:string,texto:string,aud:array<string,bool>}> */
    public function paragrafos(): array
    {
        $arq = base_path(self::ARQUIVO);
        if (! is_file($arq)) {
            return [];
        }

        return Cache::remember('ajuda-rag:'.md5_file($arq), now()->addDay(), fn () => $this->extrair((string) file_get_contents($arq)));
    }

    /** @return array<int, array{titulo:string,texto:string,aud:array<string,bool>}> */
    private function extrair(string $html): array
    {
        $doc = new DOMDocument;
        libxml_use_internal_errors(true);
        $doc->loadHTML('<?xml encoding="utf-8"?><body>'.$html.'</body>');
        libxml_clear_errors();
        $xp = new DOMXPath($doc);

        $out = [];
        foreach ($xp->query('//body/*') as $topo) {
            $titulo = '';
            $this->percorrer($topo, $titulo, $out);
        }

        return $out;
    }

    private function percorrer(DOMElement $no, string &$titulo, array &$out): void
    {
        foreach ($no->childNodes as $f) {
            if (! $f instanceof DOMElement) {
                continue;
            }
            $tag = strtolower($f->nodeName);
            if (in_array($tag, ['h3', 'h4', 'h5'], true)) {
                $titulo = $this->limpar($f->textContent);

                continue;
            }
            $temBloco = false;
            foreach ($f->childNodes as $c) {
                if ($c instanceof DOMElement && in_array(strtolower($c->nodeName), ['p', 'div', 'ul', 'ol', 'li', 'h3', 'h4', 'h5', 'details'], true)) {
                    $temBloco = true;
                    break;
                }
            }
            if ($temBloco) {
                $this->percorrer($f, $titulo, $out);

                continue;
            }
            $texto = $this->limpar($f->textContent);
            if (mb_strlen($texto) < 12) {
                continue;
            }
            $out[] = ['titulo' => $titulo, 'texto' => $texto, 'aud' => $this->audiencia($f)];
        }
    }

    private function limpar(string $s): string
    {
        return trim((string) preg_replace('/\s+/u', ' ', $s));
    }

    /** Classes de audiência do elemento e de todos os ancestrais. */
    private function audiencia(DOMElement $e): array
    {
        $aud = ['gestor' => false, 'contador' => false, 'so_contador' => false, 'frota' => false, 'sec_contador' => false, 'p_contador' => false,
            'cv' => false, 'rdm' => false, 'campo' => false];
        for ($n = $e; $n instanceof DOMElement; $n = $n->parentNode) {
            $cls = ' '.$n->getAttribute('class').' ';
            $aud['gestor'] = $aud['gestor'] || str_contains($cls, ' ajuda-gestor ');
            $aud['cv'] = $aud['cv'] || str_contains($cls, ' ajuda-cv ');
            $aud['rdm'] = $aud['rdm'] || str_contains($cls, ' ajuda-rdm ');
            $aud['campo'] = $aud['campo'] || str_contains($cls, ' ajuda-campo ');
            $aud['so_contador'] = $aud['so_contador'] || str_contains($cls, ' ajuda-so-contador ');
            $aud['frota'] = $aud['frota'] || str_contains($cls, ' ajuda-frota ');
            if (str_contains($cls, ' ajuda-contador ')) {
                $aud['contador'] = true;
                if (str_contains($cls, ' ajuda-sec ')) {
                    $aud['sec_contador'] = true;
                }
                if ($n === $e && strtolower($n->nodeName) === 'p') {
                    $aud['p_contador'] = true;
                }
            }
            if (str_contains($cls, ' ajuda-sec ') && str_contains($cls, ' ajuda-so-contador ')) {
                $aud['sec_contador'] = true;
            }
        }

        return $aud;
    }

    /** Mesmas regras do CSS de App.svelte (vejoEquipe = gestor/admin, ehContador = contabilidade, veFrota = não é contador). */
    public function visivel(array $aud, Colaborador $u): bool
    {
        $contador = $u->soLeitura();
        $equipe = $u->gerencia();
        $frota = ! $contador;

        if ($aud['so_contador']) {
            return $contador;
        }
        /* regime e função: o colaborador só lê o que usa (gestor, admin e Contador leem os dois regimes) */
        if (! $equipe && ! $contador) {
            if ($aud['cv'] && ! $u->ehCV()) {
                return false;
            }
            if ($aud['rdm'] && $u->ehCV()) {
                return false;
            }
            if ($aud['campo'] && ! ($u->registraAtividadeCampo() || $u->acompanhaCampo())) {
                return false;
            }
        }
        if ($contador) {
            if (! $aud['sec_contador']) {
                return false;
            }

            return ! $aud['gestor'] || $aud['p_contador'];
        }
        if ($aud['gestor'] && ! $equipe) {
            return false;
        }
        if ($aud['frota'] && ! ($equipe || $frota)) {
            return false;
        }

        return true;
    }

    /**
     * @return array<int, array{titulo:string,texto:string,score:float}> os melhores trechos para a pergunta, já filtrados pelo papel
     */
    public function buscar(string $pergunta, Colaborador $u, int $k = 5): array
    {
        $chunks = $this->montarChunks($u);
        $q = array_values(array_unique($this->tokens($pergunta)));
        if (! $chunks || ! $q) {
            return [];
        }

        $docs = [];
        $df = [];
        $soma = 0;
        foreach ($chunks as $i => $c) {
            $tf = array_count_values(array_merge($this->tokens($c['titulo']), $this->tokens($c['titulo']), $this->tokens($c['texto'])));
            $len = array_sum($tf);
            $docs[$i] = [$tf, $len];
            $soma += $len;
            foreach (array_keys($tf) as $t) {
                $df[$t] = ($df[$t] ?? 0) + 1;
            }
        }
        $n = count($chunks);
        $medio = max(1, $soma / $n);

        $placar = [];
        foreach ($docs as $i => [$tf, $len]) {
            $s = 0.0;
            foreach ($q as $t) {
                if (! isset($tf[$t])) {
                    continue;
                }
                $idf = log(1 + ($n - $df[$t] + 0.5) / ($df[$t] + 0.5));
                $f = $tf[$t];
                $s += $idf * ($f * 2.2) / ($f + 1.2 * (0.25 + 0.75 * $len / $medio));
            }
            if ($s > 0) {
                $placar[$i] = $s;
            }
        }
        arsort($placar);

        $res = [];
        foreach (array_slice($placar, 0, $k, true) as $i => $s) {
            $res[] = ['titulo' => $chunks[$i]['titulo'], 'texto' => $chunks[$i]['texto'], 'score' => round($s, 3)];
        }

        return $res;
    }

    /** Parágrafos visíveis ao papel, agrupados por título em blocos de até MAX_CHUNK caracteres. */
    private function montarChunks(Colaborador $u): array
    {
        $chunks = [];
        $atual = null;
        foreach ($this->paragrafos() as $p) {
            if (! $this->visivel($p['aud'], $u)) {
                continue;
            }
            if ($atual && $atual['titulo'] === $p['titulo'] && mb_strlen($atual['texto']) + mb_strlen($p['texto']) <= self::MAX_CHUNK) {
                $atual['texto'] .= "\n".$p['texto'];

                continue;
            }
            if ($atual) {
                $chunks[] = $atual;
            }
            $atual = ['titulo' => $p['titulo'], 'texto' => $p['texto']];
        }
        if ($atual) {
            $chunks[] = $atual;
        }

        return $chunks;
    }

    /** @return string[] */
    public function tokens(string $s): array
    {
        $s = mb_strtolower($s);
        $s = strtr($s, ['á' => 'a', 'à' => 'a', 'â' => 'a', 'ã' => 'a', 'ä' => 'a', 'é' => 'e', 'ê' => 'e', 'è' => 'e', 'í' => 'i', 'ì' => 'i',
            'ó' => 'o', 'ô' => 'o', 'õ' => 'o', 'ò' => 'o', 'ú' => 'u', 'ù' => 'u', 'ü' => 'u', 'ç' => 'c']);
        preg_match_all('/[a-z0-9]+/', $s, $m);
        $out = [];
        foreach ($m[0] as $t) {
            if (in_array($t, self::STOP, true) || (strlen($t) < 2)) {
                continue;
            }
            $out[] = $this->raiz($t);
        }

        return $out;
    }

    /** Raiz leve para o português: tira plural e algumas terminações, o bastante para "notas"≈"nota", "lançamentos"≈"lancamento". */
    private function raiz(string $t): string
    {
        if (strlen($t) > 5 && str_ends_with($t, 'oes')) {
            return substr($t, 0, -3).'ao';
        }
        if (strlen($t) > 4 && str_ends_with($t, 'es')) {
            $t = substr($t, 0, -2);
        } elseif (strlen($t) > 3 && str_ends_with($t, 's')) {
            $t = substr($t, 0, -1);
        }
        foreach (['mente', 'ando', 'endo', 'indo', 'ado', 'ido', 'ar', 'er', 'ir'] as $suf) {
            if (strlen($t) > strlen($suf) + 3 && str_ends_with($t, $suf)) {
                return substr($t, 0, -strlen($suf));
            }
        }

        return $t;
    }
}
