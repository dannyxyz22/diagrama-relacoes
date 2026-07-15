# Diagrama de Relações — Editor de Grafos

Webapp para montar diagramas de atores (nós) e relações (arestas coloridas com rótulos), no estilo dos diagramas de "Situação Atual / Desejada". A diagramação é automática (layout `fcose`), mas todos os elementos podem ser arrastados livremente.

## Recursos

- **Atores (nós):** nome, grupo, cor e formato (elipse, retângulo, losango, hexágono).
- **Grupos (blobs):** agrupam atores num contêiner colorido (ex.: "PAÍS AZUL").
- **Relações (arestas):** origem/destino, rótulo, cor, estilo (sólida/tracejada/pontilhada) e opção bidirecional.
- **Tipos de relação / legenda:** predefinidos (Apoio/Aliança = azul, Antagonismo = vermelho, Influência/Dependência = preto) e personalizáveis.
- **Layout automático** com botão "Reorganizar" e opção de auto-organizar ao editar.
- **Arrastar** qualquer nó; as posições são preservadas.
- **Inspector:** clique num elemento no grafo para editar ou remover.
- **Persistência automática** no navegador (localStorage).
- **Exportar PNG**, **Salvar/Abrir JSON** e um **Exemplo** pré-carregado.

## Como rodar

```bash
cd app-grafos
npm install
npm run dev
```

Abra a URL indicada pelo Vite (normalmente http://localhost:5173).

Para gerar a versão de produção:

```bash
npm run build
npm run preview
```

## Uso rápido

1. Aba **Grupos** (opcional): crie blobs como "PAÍS AZUL".
2. Aba **Atores**: cadastre os nós, escolhendo cor e (opcional) grupo.
3. Aba **Relações**: escolha origem/destino, escreva o rótulo e selecione o tipo (define a cor).
4. Use **Reorganizar (auto)** para a diagramação automática; arraste os nós para ajustar.
5. **Exportar PNG** ou **Salvar JSON** quando terminar.
