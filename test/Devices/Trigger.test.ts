import chai, { expect } from "chai";
import sinonChai from "sinon-chai";

import { TriggerController } from "../../src/Devices/Remote/TriggerController";

chai.use(sinonChai);

describe("Trigger", () => {
    let trigger: TriggerController;

    let processor: any;
    let button: any;
    let index: any;

    beforeEach(() => {
        index = 1;

        processor = { id: "TEST-ID" };
        button = { href: "/AREA/TEST-TRIGGER" };
    });

    it("should properly define the id", () => {
        trigger = new TriggerController(processor, button, index);

        expect(trigger.id).to.equal("LEAP-TEST-ID-BUTTON-TEST-TRIGGER");
    });

    it("should properly set the trigger definition", () => {
        button.Name = "TEST-NAME";
        trigger = new TriggerController(processor, button, index, { raiseLower: true });

        expect(trigger.definition.name).to.equal("TEST-NAME");
        expect(trigger.definition.id).to.equal("LEAP-TEST-ID-BUTTON-TEST-TRIGGER");
        expect(trigger.definition.index).to.equal(1);
        expect(trigger.definition.raiseLower).to.equal(true);
    });

    describe("update()", () => {
        it("should emit a press event when a trigger is updated", (done) => {
            trigger = new TriggerController(processor, button, index, {
                clickSpeed: 0,
                doubleClickSpeed: 0,
            });

            trigger.on("Press", (response) => {
                expect(response.id).to.equal("LEAP-TEST-ID-BUTTON-TEST-TRIGGER");

                done();
            });

            trigger.update({ ButtonEvent: { EventType: "Press" } } as any);
            trigger.update({ ButtonEvent: { EventType: "Release" } } as any);
        });

        it("should emit a press event when a trigger is updated and long press is enabled", () => {
            trigger = new TriggerController(processor, button, index, {
                clickSpeed: 10,
                doubleClickSpeed: 0,
            });

            trigger.update({ ButtonEvent: { EventType: "Press" } } as any);
            trigger.update({ ButtonEvent: { EventType: "Release" } } as any);
            trigger.update({ ButtonEvent: { EventType: "Press" } } as any);
            trigger.update({ ButtonEvent: { EventType: "Release" } } as any);
            trigger.update({ ButtonEvent: { EventType: "Press" } } as any);
            trigger.update({ ButtonEvent: { EventType: "Release" } } as any);
        });

        it("should emit a double press event when a trigger is updated twice", (done) => {
            trigger = new TriggerController(processor, button, index, { doubleClickSpeed: 15 });

            trigger.on("DoublePress", (response) => {
                expect(response.id).to.equal("LEAP-TEST-ID-BUTTON-TEST-TRIGGER");

                done();
            });

            trigger.update({ ButtonEvent: { EventType: "Press" } } as any);
            trigger.update({ ButtonEvent: { EventType: "Release" } } as any);

            setTimeout(() => {
                trigger.update({ ButtonEvent: { EventType: "Press" } } as any);
                trigger.update({ ButtonEvent: { EventType: "Release" } } as any);
            }, 10);
        });

        it("should reset the trigger state if button is pressed during a double press", () => {
            trigger = new TriggerController(processor, button, index, { doubleClickSpeed: 15 });

            trigger.update({ ButtonEvent: { EventType: "Press" } } as any);
            trigger.update({ ButtonEvent: { EventType: "Release" } } as any);

            setTimeout(() => {
                trigger.update({ ButtonEvent: { EventType: "Press" } } as any);
                trigger.update({ ButtonEvent: { EventType: "Release" } } as any);
            }, 5);
        });

        it("should emit a long press event when a trigger is updated", (done) => {
            trigger = new TriggerController(processor, button, index, { clickSpeed: 10 });

            trigger.on("LongPress", (response) => {
                expect(response.id).to.equal("LEAP-TEST-ID-BUTTON-TEST-TRIGGER");

                done();
            });

            trigger.update({ ButtonEvent: { EventType: "Press" } } as any);

            setTimeout(() => {
                trigger.update({ ButtonEvent: { EventType: "Press" } } as any);
            }, 10);
        });

        it("should reset the trigger state if button is pressed and released during the long press timer", () => {
            trigger = new TriggerController(processor, button, index, { doubleClickSpeed: 15 });

            trigger.update({ ButtonEvent: { EventType: "Press" } } as any);
            trigger.update({ ButtonEvent: { EventType: "Release" } } as any);
            trigger.update({ ButtonEvent: { EventType: "press" } } as any);
            trigger.update({ ButtonEvent: { EventType: "Release" } } as any);
        });

        describe("raiseLower raw mode", () => {
            it("should emit Press immediately on LEAP Press", (done) => {
                trigger = new TriggerController(processor, button, index, { raiseLower: true });

                trigger.on("Press", (response) => {
                    expect(response.id).to.equal("LEAP-TEST-ID-BUTTON-TEST-TRIGGER");
                    done();
                });

                trigger.update({ ButtonEvent: { EventType: "Press" } } as any);
            });

            it("should emit Release on LEAP Release (real finger-up)", (done) => {
                trigger = new TriggerController(processor, button, index, { raiseLower: true });
                const events: string[] = [];

                trigger.on("Press", () => events.push("Press"));
                trigger.on("Release", () => {
                    events.push("Release");
                    expect(events).to.deep.equal(["Press", "Release"]);
                    done();
                });
                trigger.on("LongPress", () => events.push("LongPress"));
                trigger.on("DoublePress", () => events.push("DoublePress"));

                trigger.update({ ButtonEvent: { EventType: "Press" } } as any);
                trigger.update({ ButtonEvent: { EventType: "Release" } } as any);
            });

            it("should not classify LongPress while held", (done) => {
                trigger = new TriggerController(processor, button, index, {
                    raiseLower: true,
                    clickSpeed: 10,
                });
                const events: string[] = [];

                trigger.on("Press", () => events.push("Press"));
                trigger.on("Release", () => events.push("Release"));
                trigger.on("LongPress", () => events.push("LongPress"));

                trigger.update({ ButtonEvent: { EventType: "Press" } } as any);

                setTimeout(() => {
                    trigger.update({ ButtonEvent: { EventType: "Release" } } as any);
                    expect(events).to.deep.equal(["Press", "Release"]);
                    done();
                }, 50);
            });

            it("should not emit DoublePress on rapid clicks", (done) => {
                trigger = new TriggerController(processor, button, index, {
                    raiseLower: true,
                    doubleClickSpeed: 50,
                });
                const events: string[] = [];

                trigger.on("Press", () => events.push("Press"));
                trigger.on("Release", () => events.push("Release"));
                trigger.on("DoublePress", () => events.push("DoublePress"));

                trigger.update({ ButtonEvent: { EventType: "Press" } } as any);
                trigger.update({ ButtonEvent: { EventType: "Release" } } as any);
                trigger.update({ ButtonEvent: { EventType: "Press" } } as any);
                trigger.update({ ButtonEvent: { EventType: "Release" } } as any);

                setTimeout(() => {
                    expect(events).to.deep.equal(["Press", "Release", "Press", "Release"]);
                    done();
                }, 20);
            });
        });
    });
});
