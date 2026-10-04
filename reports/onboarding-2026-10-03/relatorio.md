# Investigação de onboarding — Telegram Manager

**Data:** 3 de outubro de 2026 · **Ambiente avaliado:** `master.d1igxmqb7mhi9s.amplifyapp.com` · **Dispositivo:** Safari desktop e viewport móvel de 390 × 844 px · **Cenário:** conta nova e grupo de teste “Efra Teste 2”.

## Resumo executivo

O produto tem um caminho de conexão, mas ainda não oferece uma experiência de onboarding que conduza o usuário até um resultado comprovado. A conta nova abre num painel de métricas zeradas; o convite e a entrada do bot no Telegram funcionaram; o site reconheceu corretamente o grupo e as permissões; a última ação, **“Proteger grupo”**, retornou erro interno em três tentativas. A comunidade não foi conectada ao workspace e, portanto, o teste não alcançou o primeiro valor. A falha é reproduzível em desktop e no viewport móvel.

Os registros da versão publicada no CloudWatch mostram `dashboard_write_failed` com classe registrada como `Error` às **22:51:45**, **22:51:53** e **22:56:31** (horário de Brasília). O registro atual omite a etapa e a causa. O código passa, nessa ordem, por descriptografia da credencial do bot, verificação do grupo e dos administradores no Telegram e transação que cria comunidade e regra. Não há evidência suficiente para apontar uma dessas etapas como a causa raiz. Como a resposta HTTP exibida foi o erro interno genérico, a falha não foi tratada como erro conhecido de permissão.

Preparei localmente uma melhoria de diagnóstico sem registrar credenciais, IDs ou mensagens; um aviso de falha persistente junto à ação; o cartão móvel em uma coluna; estado de convite perdido; rótulos de status mais precisos; e encaminhamento para testar a regra após uma conexão bem-sucedida. **Essas alterações não foram publicadas.**

## Método e alcance

Segui o percurso de alguém sem conhecimento da implementação: criação de conta, leitura do primeiro painel, abertura da conexão, adição do bot ao grupo “Efra Teste 2”, retorno ao produto e tentativa de ativação. A criação da credencial e a confirmação do administrador no Telegram foram feitas pelo titular da conta durante o teste. Observei a interface publicada no Safari e no modo responsivo, consultei os eventos no CloudWatch da conta AWS conectada no Chrome e confrontei o comportamento com o código local.

Esta é **uma observação qualitativa (n = 1)**. Ela revela bloqueios e passos, mas não produz média estatística de tempo, taxa de sucesso ou conversão. O tempo de parede foi afetado pela troca de aplicativos, inspeção e intervenções assistidas; seria enganoso apresentá-lo como tempo de um usuário comum.

## Qual deve ser o primeiro valor?

O valor central prometido é: **uma mensagem real do grupo é analisada pela regra desejada, a ação correta acontece, e o administrador consegue verificar o motivo no Registro**. Conectar um bot é configuração, não benefício consumado. Para diminuir o tempo até uma demonstração clara, proponho um marco anterior: **simular uma mensagem de exemplo e exibir a decisão e a regra aplicada, sem tocar no Telegram**. Esse marco permite conferir a configuração com baixo risco; depois, o usuário valida o resultado no próprio grupo.

Instrumentação sugerida:

| Marco | Evento sugerido | Condição de sucesso |
| --- | --- | --- |
| Início | `signup_completed` | Primeiro painel carregado na conta nova |
| Preparação | `group_discovered` | Bot e grupo reconhecidos |
| Ativação | `group_connected` | Comunidade persistida e acesso verificado |
| Prova rápida | `first_rule_test_viewed` | Decisão da simulação exibida ao usuário |
| Primeiro valor real | `first_live_decision_viewed` | Decisão de mensagem real visível no Registro, com ação e justificativa |

Medir mediana e percentis do tempo entre cadastro e cada marco, além de tentativas, cliques, falhas e abandono por etapa; segmentar principalmente por móvel. Para valor de moderação acionada, acompanhar também a primeira ação real bem-sucedida, pois um grupo pode passar dias sem spam.

## Jornada observada e esforço

| Etapa | Ação significativa após o cadastro | O que aconteceu |
| --- | ---: | --- |
| Painel inicial | 1. “Conectar grupo” | Abriu a área de integração. O painel mostrava zeros, gráfico e Registro vazios. |
| Integração | 2. “Adicionar meu grupo” | Criou convite temporário. |
| Saída para Telegram | 3. “Abrir Telegram para escolher o grupo” | Link abriu escolha de aplicativo. |
| Sistema | 4. Permitir abertura do Telegram | Troca de contexto entre navegador e aplicativo. |
| Telegram | 5. Selecionar “Efra Teste 2” | Grupo escolhido. |
| Telegram | 6. “Add Bot as Admin” | Bot entrou com permissões de excluir mensagens e restringir/banir usuários. |
| Volta ao produto | 7. “Proteger grupo” | Erro interno. Mais duas tentativas também falharam. |

**Resultado observado: 7 ações até o bloqueio, 0 ações até o primeiro valor porque ele não foi alcançado.** Esse número inclui o diálogo do sistema e a confirmação no Telegram; não inclui digitação do cadastro ou intervenções da investigação. Não é uma média populacional. A conexão publicada tem uma janela de 15 minutos, que adiciona pressão quando o usuário precisa voltar de outro aplicativo.

## Evidências visuais

### 1. Primeiro acesso móvel: informação vazia compete com a tarefa

![Painel inicial móvel com números zerados e chamada para conectar o grupo](</Users/efraimfelix/Desktop/Telegram Manager/reports/onboarding-2026-10-03/01-primeiro-acesso-mobile.png>)

O CTA existe e está visível, mas o usuário vê status “Proteção pausada” antes de ter grupo, três números zerados, gráfico vazio, Registro vazio, bloco de participantes sem dados e uso mensal. Isso aumenta leitura sem aproximar o primeiro resultado. “Bot conectado” no topo da versão publicada comunica conexão com o grupo quando apenas o bot do sistema está disponível.

### 2. Grupo encontrado: CTA estrangula nome e explicação no celular

![Cartão móvel do grupo reconhecido com texto comprimido ao lado do botão Proteger grupo](</Users/efraimfelix/Desktop/Telegram Manager/reports/onboarding-2026-10-03/02-grupo-encontrado-mobile.png>)

O grupo foi detectado, mas o nome e a frase quebram quase palavra a palavra, pois competem com o botão na mesma linha. A tela diz “Pronto para proteger” sem esclarecer que a confirmação ainda pode falhar. Após a falha, o aviso global aparecia brevemente e sumia quando a atualização periódica recarregava o painel. A imagem acima prova o problema de composição; o erro é sustentado pelas três respostas observadas e pelos registros do servidor, não por esta captura.

### 3. Proposta de etapa de primeiro resultado

[Abrir a proposta interativa](./proposta-onboarding.html). Ela mostra uma etapa curta após a conexão: progresso, grupo reconhecido, regra inicial para revisão, exemplo pré-preenchido, teste seguro e decisão explicada. O azul é controlado por variável, coerente com o tema profissional atual.

## Achados priorizados

| Prioridade | Achado | Efeito para o usuário | Recomendação |
| --- | --- | --- | --- |
| P0 | “Proteger grupo” retorna 500, repetidamente | Bloqueia todo o valor e não oferece solução | Identificar a etapa exata com logs seguros; corrigir a causa; validar conexão, regra, teste e mensagem real na versão publicada. |
| P0 | Logs registram só `Error` | Diagnóstico lento; classe genérica e nenhuma etapa | Registrar fase da confirmação e classe real, sem conteúdo privado; manter ID de correlação se necessário. |
| P1 | Falha some durante a atualização de 2 s | Usuário pode achar que nada aconteceu e clicar de novo | Manter erro até nova ação, junto ao botão, com instrução de recuperação. |
| P1 | Grupo e botão dividem linha estreita em 390 px | Nome, status e ação ficam difíceis de ler | Empilhar CTA em largura total no móvel; preservar nome e status juntos. |
| P1 | O primeiro painel entrega seis estados vazios | A tarefa principal perde foco; status sugere proteção existente | Tela inicial de ativação com um único próximo passo e prévia do benefício; liberar métricas após haver dados. |
| P1 | Conexão bem-sucedida terminaria no painel de bot | Teste da regra depende de descoberta manual | Abrir a etapa de teste com mensagem de exemplo e explicação da decisão. |
| P1 | Regra inicial criada já ativa e com exclusão de mensagem | Moderação pode começar antes da revisão do administrador | Exibir regra/ação e pedir revisão ou teste antes de ativar na comunidade real. |
| P2 | Um convite pendente não pode ser reaberto após recarga | Usuário precisa adivinhar que deve começar de novo | Explicar que o convite aguarda o Telegram e oferecer “Gerar novo convite”. |
| P2 | Nome exibido do bot contém “manger” | Pode parecer bot não oficial no passo que pede poderes de moderação | Alinhar nome, foto e username do bot à marca; explicar exatamente as permissões. |
| P2 | “Participantes” anuncia entradas e saídas, mas não captura eventos | Promessa anterior do produto não se concretiza | Planejar eventos de membro (`new_chat_members`, `left_chat_member`/`chat_member`), persistência e visão de 7 dias; distinguir eventos observados de saldo histórico. |

### Onboarding atual: existe?

Existe **um caminho operacional de conexão com instruções** em “Como conectar” e estados vazios em Regras. Não existe um fluxo completo orientado ao resultado, com progresso, continuidade após a troca de aplicativo, teste guiado e conclusão verificável. “Comece com uma sugestão” já aparece apenas quando não há regras, conforme solicitado anteriormente; o teste de conta nova não chegou a esse ponto porque a conexão falhou.

### Integrações: o que funcionou e o que não foi possível validar

| Integração/etapa | Resultado |
| --- | --- |
| Criação de conta e acesso ao painel | Funcionaram no teste. |
| Geração de convite para Telegram | Funcionou. |
| Adição do bot como administrador de “Efra Teste 2” | Funcionou; permissões solicitadas foram excluir mensagens e restringir/banir usuários. |
| Recebimento do evento e descoberta do grupo | Funcionou: o site exibiu nome, candidato e permissões de administrador. |
| Confirmação do grupo no workspace | Falhou três vezes com erro interno. |
| Regra inicial, teste e moderação real no grupo novo | Não validáveis, pois a confirmação bloqueou a sequência. |
| Entradas e saídas de participantes | Não implementadas de ponta a ponta na versão analisada. |

## Trabalho preparado no código local

- `src/modules/dashboard/service.ts`: registra etapa e classe da falha de confirmação sem credenciais, mensagens ou IDs.
- `src/app/api/dashboard/route.ts`: usa classe real do erro no log genérico.
- `src/modules/dashboard/http.ts`: respostas inesperadas e falhas do Telegram em português.
- `src/components/dashboard.tsx`: mantém erros de ação durante polling, mostra o erro perto da confirmação, oferece recuperação do convite perdido, indica “Bot disponível”/“Sem grupo conectado” e abre Regras após conectar.
- `src/app/globals.css`: empilha o botão do cartão de grupo em largura total no celular.

O layout alterado foi inspecionado no Safari local com viewport de **390 × 844 px** em um grupo já conectado. `pnpm typecheck`, `pnpm lint` e `git diff --check` passaram. O grupo novo da produção segue **sem conexão confirmada** e a causa raiz do 500 segue **em aberto**, porque a versão publicada não informa a etapa. Não houve push, deploy nem alteração de infraestrutura AWS nesta investigação.

## Próximo passo decisivo

Publicar primeiro a instrumentação segura e a melhoria da interface; repetir a confirmação em “Efra Teste 2”; ler a nova linha `connection_confirmation_failed` com a etapa; corrigir a causa específica; então completar o teste de regra, uma mensagem real e o Registro. Só depois disso medir tempo até valor em uma amostra maior de novos usuários móveis.
