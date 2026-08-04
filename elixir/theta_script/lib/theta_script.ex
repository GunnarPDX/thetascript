defmodule ThetaScript.Native do
  @moduledoc false
  use Rustler,
    otp_app: :theta_script,
    crate: "theta_script_nif",
    path: "../../rust/theta-script-nif"

  # NIF stubs — replaced when the shared library loads
  def run_script_json(_source, _bars_json, _opts_json), do: :erlang.nif_error(:nif_not_loaded)
  def lang_version, do: :erlang.nif_error(:nif_not_loaded)
end

defmodule ThetaScript do
  @moduledoc """
  Elixir bindings for the open-financial-charts scripting language core (Rust).

  The API is JSON-in / JSON-out, matching the language's wire encoding
  (NaN -> null, ±Infinity -> "Infinity"/"-Infinity"). See spec/SPEC.md
  in the open-financial-charts repo for the language definition.

      bars_json = Jason.encode!(bars)   # [{date, open, high, low, close, volume}]
      opts_json = Jason.encode!(%{timezone: "UTC"})
      {:ok, json} = ThetaScript.run_json(source, bars_json, opts_json)
      result = Jason.decode!(json)

  The NIF runs on a dirty CPU scheduler, so long tapes don't block the VM.
  """

  @doc "Run a script; JSON strings in, wire-encoded JSON result out."
  @spec run_json(String.t(), String.t(), String.t()) :: {:ok, String.t()} | {:error, String.t()}
  def run_json(source, bars_json, opts_json \\ "") do
    ThetaScript.Native.run_script_json(source, bars_json, opts_json)
  end

  @doc "The language/spec version this NIF implements."
  @spec lang_version() :: String.t()
  def lang_version, do: ThetaScript.Native.lang_version()
end
