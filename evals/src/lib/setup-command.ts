export type TestSetupCommand = {
  /**
   * Deterministic user-history seed. Adapters decide how to bridge this into
   * their runtime; the simulator is not involved in setup.
   */
  type: "user-message";
  content: string;
};
