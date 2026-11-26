# Showing Sparelimit's output in public

A post cannot be taken back. Before you show anything Sparelimit printed, make the share-safe form of it, check it, and look at it once yourself.

## The share-safe forms

Add `--share` and the output keeps every number and drops what points at you: exact times become days, and session ids are removed.

```bash
sparelimit week --share            # the weekly summary
sparelimit ledger --share          # the savings ledger (add --json for the machine form)
sparelimit card --share            # the picture and the page; --hide-dollars leaves the amounts out
```

Each one then runs the same check as `sparelimit safe-to-share` on its own output and says on stderr what it found. The output itself stays on stdout, so a JSON stays a JSON.

If you made a file another way, check it:

```bash
sparelimit safe-to-share output.txt
```

It looks for home-folder paths, email addresses, session ids, exact times, credential shapes and names from your machine (your user name, your computer's name, your project folders). "Nothing found" does not mean safe in every way. Read the file yourself once.

## The rule for a screenshot

1. **Read the whole image at full size** before you post it, not a thumbnail. Text hides in corners and in window titles.
2. **Crop it, or cover what you must hide with a solid block.** Never blur: a blur can be partly undone, and it still shows the shape of what was there.
3. **Never change a number.** Not to round it, not to make it fit. If a number is wrong, fix the cause and take the picture again.
4. **Show the command and the date.** A figure with no command cannot be checked, and a figure with no date cannot be compared.
5. **A picture cannot be scanned by a program.** Make the picture from a `--share` output, check that text, then look at the picture.

## What not to show

- **The dashboard** (`sparelimit serve`). It shows session ids, project names, exact times and paths, and it has no share-safe mode. Do not screenshot it. Use `sparelimit card --share`, or a `--share` text output.
- A terminal window with your prompt in it. The prompt line often holds your user name, your computer's name and a folder.
- Anything from `sparelimit why`, `sparelimit timeline`, `sparelimit files` or `sparelimit handoff`. They name sessions, files or work. They are for you.

## What a share-safe output still tells people

Days you worked, how many alerts fired, and what happened to each. That is the point of showing it. If you do not want people to see which days you worked, show `sparelimit card --share` instead of the ledger.

Every number says how sure it is: **exact**, **derived** or **estimated**. Dollars are API-equivalent at list price. On a subscription they show size and share of your limit, not an invoice. A figure that comes from one machine says so.
