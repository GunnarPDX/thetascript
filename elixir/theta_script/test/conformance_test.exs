defmodule ThetaScript.ConformanceTest do
  use ExUnit.Case, async: false

  @moduledoc """
  Runs the shared conformance corpus (conformance/) through the
  NIF. Same policy as the JS/Rust/Python harnesses: exact numeric equality
  with a 1e-9 relative tolerance; err-* fixtures must error with matching
  collections, message text ignored.
  """

  @corpus Path.expand("../../../conformance", __DIR__)

  defp compare(got, want, path, diffs) when is_number(want) do
    cond do
      not is_number(got) -> ["#{path}: got #{inspect(got)} want number" | diffs]
      got == want -> diffs
      abs(got - want) <= 1.0e-9 * max(abs(got * 1.0), abs(want * 1.0)) -> [{:tolerated, path} | diffs]
      true -> ["#{path}: got #{inspect(got)} want #{inspect(want)}" | diffs]
    end
  end

  defp compare(got, want, path, diffs) when is_list(want) do
    cond do
      not is_list(got) or length(got) != length(want) ->
        ["#{path}: array shape mismatch" | diffs]

      true ->
        got
        |> Enum.zip(want)
        |> Enum.with_index()
        |> Enum.reduce(diffs, fn {{x, y}, k}, acc -> compare(x, y, "#{path}[#{k}]", acc) end)
    end
  end

  defp compare(got, want, path, diffs) when is_map(want) do
    cond do
      not is_map(got) or Map.keys(got) |> Enum.sort() != Map.keys(want) |> Enum.sort() ->
        ["#{path}: key sets differ" | diffs]

      true ->
        Enum.reduce(want, diffs, fn {k, y}, acc -> compare(Map.get(got, k), y, "#{path}.#{k}", acc) end)
    end
  end

  defp compare(got, want, path, diffs) do
    if got == want, do: diffs, else: ["#{path}: got #{inspect(got)} want #{inspect(want)}" | diffs]
  end

  test "language version matches every fixture's lang field" do
    # the corpus carries the version contract — no hardcoded string to
    # forget on the next language bump
    for file <- Path.wildcard(Path.join(@corpus, "expected/*.json")) do
      fx = Jason.decode!(File.read!(file))
      assert ThetaScript.lang_version() == fx["lang"],
             "#{fx["name"]}: NIF speaks #{ThetaScript.lang_version()}, fixture is #{fx["lang"]}"
    end
  end

  test "conformance corpus" do
    tapes = Jason.decode!(File.read!(Path.join(@corpus, "tapes.json")))
    files = Path.wildcard(Path.join(@corpus, "expected/*.json")) |> Enum.sort()
    assert files != []

    {failures, tolerated} =
      Enum.reduce(files, {[], 0}, fn file, {fails, tol} ->
        fx = Jason.decode!(File.read!(file))
        name = fx["name"]
        bars_json = Jason.encode!(tapes[fx["tape"]])
        opts_json = Jason.encode!(fx["opts"])
        {:ok, json} = ThetaScript.run_json(fx["script"], bars_json, opts_json)
        got = Jason.decode!(json)
        want = fx["expected"]

        {got, want, err_ok} =
          if String.starts_with?(name, "err-") do
            {Map.put(got, "error", nil), Map.put(want, "error", nil), is_binary(got["error"])}
          else
            {got, want, true}
          end

        diffs = if err_ok, do: compare(got, want, name, []), else: ["#{name}: expected an error"]
        {tols, real} = Enum.split_with(diffs, &match?({:tolerated, _}, &1))
        {fails ++ real, tol + length(tols)}
      end)

    IO.puts("elixir binding conformance: #{length(files)} fixtures, #{tolerated} values within tolerance")
    assert failures == [], Enum.take(failures, 20) |> Enum.join("\n")
  end
end
