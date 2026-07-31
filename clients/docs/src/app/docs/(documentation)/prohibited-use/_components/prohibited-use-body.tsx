import { DocsContent } from "@/app/docs/_components/docs-content";

export function ProhibitedUseBody() {
  return (
    <DocsContent title="Vellum Prohibited Use Policy" breadcrumb="Docs / Legal / Prohibited Use">
                  <p>
                    <em>Last Updated: April 6, 2026</em>
                  </p>
                  <p>
                    Vellum (&quot;<strong>we</strong>&quot; or &quot;<strong>us</strong>&quot;) makes
                    its Services available subject to the terms of the Terms of Service (the
                    &quot;<strong>Agreement</strong>&quot;) and this Prohibited Use Policy
                    (&quot;<strong>Policy</strong>&quot;). The purpose of this Policy is to ensure
                    the Services are used safely, ethically, and in accordance with all applicable
                    laws and regulations. Any defined terms used but not defined in this Policy have
                    the meaning given in the Agreement.
                  </p>

                  <h2>Purpose and Permitted Uses</h2>
                  <p>
                    The Services are intended to allow you to create AI agent assistants and automate
                    your tasks. Examples of permitted automations include, but are not limited to:
                  </p>
                  <ul>
                    <li>
                      Sending communications, input, posts and content to platforms, individuals,
                      devices or websites on your behalf, approximating the rate at which a human
                      could send and that is traceable to you.
                    </li>
                    <li>
                      Allowing your assistant to access, delete and modify files that you have the
                      right to access, delete or modify as the user (including under all applicable
                      laws).
                    </li>
                    <li>
                      Integrating with and commanding your assistant to complete tasks on Third-Party
                      Services in compliance with such Third-Party Services terms and conditions.
                    </li>
                  </ul>

                  <h2>Prohibited Uses</h2>
                  <p>
                    You may not use the Services, Outputs or Results or derivatives thereof, for any
                    of the following purposes:
                  </p>

                  <h3>
                    Unlawful, Harmful, or Unethical Activities
                  </h3>
                  <ul>
                    <li>
                      Any activity that violates applicable local, national, or international laws,
                      rules, or regulations, including, but not limited to:
                      <ul>
                        <li>
                          Sending communications, input, posts and content to platforms, individuals,
                          devices or websites at a rate significantly exceeding reasonable human use
                          or not traceable to you.
                          <ul>
                            <li>
                              Human use defined as what a human could accomplish, including access to
                              widely known, commercially available tools (<em>
                                Prompting an agent to send emails to a properly procured opt-in
                                mailing list is ok. Attempting to prompt an agent to perform
                                DDoS or uninvited DM spam, attempting SQL injections is not ok
                              </em>)
                            </li>
                          </ul>
                        </li>
                      </ul>
                    </li>
                    <li>
                      Any use that infringes upon or violates the rights of others, including,
                      infringement or misappropriation, invasion of privacy, or jeopardizing the
                      safety of others.
                    </li>
                    <li>
                      Any activity that causes or is intended to cause harm, including but not
                      limited to the generation of offensive, abusive, or unlawful content.
                    </li>
                  </ul>

                  <h3>
                    Security and Privacy Violations
                  </h3>
                  <ul>
                    <li>Introducing malware, viruses, or other malicious code.</li>
                    <li>
                      Circumventing or attempting to circumvent any security or access controls
                      (including, legal, contractual or technical), including but not limited to:
                      <ul>
                        <li>
                          Allowing your assistant access to, or to delete or modify, any files,
                          folders, directories or any other digital asset that you do not have rights
                          to access, delete, or modify as the user.
                        </li>
                      </ul>
                    </li>
                    <li>
                      Collecting, storing, or sharing sensitive, health, or personal data without
                      proper authorization or consent.
                    </li>
                  </ul>

                  <h3>Misinforming or Misleading</h3>
                  <ul>
                    <li>
                      Generation, dissemination, or promotion of false, incomplete, or otherwise
                      misleading information.
                    </li>
                    <li>
                      Any use intended to deceive, misinform, or otherwise mislead individuals or
                      organizations, including but not limited to fabrication of data, fabrication or
                      manipulation of outputs, impersonation, or to otherwise misrepresent facts or
                      scientific findings.
                    </li>
                    <li>
                      Any attempt to obfuscate yourself in connection to your assistant is
                      prohibited.
                      <ul>
                        <li>
                          Prompting your assistant to write input of any kind that attempts to
                          inhibit a third party from understanding that you the user is prompting an
                          agent to action.
                        </li>
                        <li>
                          Your Assistant will ALWAYS identify itself as an Automated Assistant if
                          possible.
                        </li>
                        <li>
                          Attempting to prompt your Assistant to action input of any kind
                          impersonating a human being (<em>yourself or others</em>) is prohibited.
                        </li>
                        <li>Attempting to circumvent this is prohibited.</li>
                      </ul>
                    </li>
                  </ul>

                  <h2>Disclaimer</h2>
                  <p>
                    The Services are provided AS IS and subject to error, and you are solely
                    responsible for the accuracy and appropriateness of all use of the Services,
                    Outputs, and Results.
                  </p>

                  <h2>Third Party Services</h2>
                  <p>
                    We are not responsible for the content, security, or privacy practices of any
                    Third-Party Services that you may use in connection with the Services. Use of
                    such Third-Party Services is at your own risk and subject to the terms and
                    policies of the respective third parties. We disclaim any liability for damages
                    or losses resulting from Third-Party Services.
                  </p>

                  <h2>
                    Legal and Regulatory Compliance
                  </h2>
                  <p>
                    The Services may not be appropriate or available for use in some jurisdictions.
                    Any use of the Services is at your own risk, and you must comply with applicable
                    laws, rules, and regulations in doing so. This includes, but is not limited to,
                    data protection, privacy, and export control laws.
                  </p>
    </DocsContent>
  );
}
