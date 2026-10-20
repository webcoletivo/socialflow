// o parâmetro de tipo existe só para casar com a assinatura RouteContext<"/rota"> do Next
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type RouteContext<_Path extends string = string> = {
  params: Promise<Record<string, string>>;
};
