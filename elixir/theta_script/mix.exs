defmodule ThetaScript.MixProject do
  use Mix.Project

  def project do
    [
      app: :theta_script,
      version: "2.4.0",
      elixir: "~> 1.14",
      start_permanent: Mix.env() == :prod,
      deps: deps(),
      package: [licenses: ["MIT"]]
    ]
  end

  def application do
    [extra_applications: [:logger]]
  end

  defp deps do
    [
      {:rustler, "~> 0.36.0", runtime: false},
      {:jason, "~> 1.4"}
    ]
  end
end
